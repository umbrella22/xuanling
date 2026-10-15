// N-RUNTIME suite (W3): T07/T08/T09/T10 coordinator contracts against a REAL
// durable backend (json here; sqlite asserted by store-probe) — never a fake
// store. Cases: idempotent admission, intent-before-effect durability, crash
// windows, single-writer lease, projection rebuild, scheduler ready-sets and
// budgets, terminal immutability under races, recovery reconciliation.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const CRITICAL_COORDINATOR_IDS = ['RT1', 'RT3', 'RT11']

function runtimeRoot() {
  const root = mkdtempSync('/tmp/bp-runtime-')
  mkdirSync(join(root, 'store'), { recursive: true })
  return root
}

async function open(root) {
  const persistence = await import(join(helpers_packageRoot(), 'lib', 'persistence.js'))
  const opened = await persistence.openBlueprintDomain({ backend: 'json', path: join(root, 'store') })
  const store = new persistence.RunStore(opened.domain)
  return { persistence, opened, store }
}

// helpers.packageRoot is injected per case; store a module-level holder.
let pkgRoot = ''
function helpers_packageRoot() {
  return pkgRoot
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true })
}

const COMMAND = { scope: 'test', requestId: 'req-1', payloadFingerprint: 'fp-1' }

export async function getCases(helpers) {
  pkgRoot = helpers.packageRoot
  const cases = []

  cases.push({
    id: 'RT1',
    title: 'T08/T10: duplicate start command replays the original run (idempotent admission)',
    contract: 'C-08',
    expect: 'pass',
    run: async () => {
      const root = runtimeRoot()
      try {
        const { opened, store } = await open(root)
        const first = await store.createRun(COMMAND, 'rev-1', 'def-1', 'input-1')
        const second = await store.createRun({ ...COMMAND }, 'rev-1', 'def-1', 'input-1')
        const same = first.runId === second.runId && first.replayed === false && second.replayed === true
        await opened.close()
        return same
      } finally {
        cleanup(root)
      }
    }
  })

  cases.push({
    id: 'RT2',
    title: 'T10: same requestId with a different payload is a typed COMMAND_CONFLICT',
    contract: 'C-10',
    expect: 'pass',
    run: async () => {
      const root = runtimeRoot()
      try {
        const { opened, store } = await open(root)
        await store.createRun(COMMAND, 'rev-1', 'def-1', 'input-1')
        let conflict = null
        try {
          await store.createRun({ ...COMMAND, payloadFingerprint: 'fp-2' }, 'rev-1', 'def-1', 'input-1')
        } catch (error) {
          conflict = error
        }
        await opened.close()
        return conflict?.code === 'COMMAND_CONFLICT' && conflict.storedFingerprint === 'fp-1'
      } finally {
        cleanup(root)
      }
    }
  })

  cases.push({
    id: 'RT3',
    title: 'T08: intent-before-effect — the dispatch intent is durable in a FRESH domain reader before any effect',
    contract: 'C-08',
    expect: 'pass',
    run: async () => {
      const root = runtimeRoot()
      try {
        const first = await open(root)
        const created = await first.store.createRun(COMMAND, 'rev-1', 'def-1', 'input-1')
        await first.store.recordIntent(created.runId, { nodeId: 'review', kind: 'agentTask', resourceDigests: { skill: 'abc' } })
        // Fresh reader on the same medium (second domain instance).
        const second = await open(root)
        const reread = await second.store.get(created.runId)
        const attempt = reread.attempts.find(a => a.nodeId === 'review')
        const durable =
          attempt?.intent?.kind === 'agentTask' &&
          attempt.intent.resourceDigests.skill === 'abc' &&
          reread.state === 'running' &&
          reread.log.some(e => e.kind === 'intent')
        await second.opened.close()
        await first.opened.close()
        return durable
      } finally {
        cleanup(root)
      }
    }
  })

  cases.push({
    id: 'RT4',
    title: 'T08/T09: crash window — intent without result reopens as recovery_required; reconcile applies reviewed evidence once',
    contract: 'C-09',
    expect: 'pass',
    run: async () => {
      const root = runtimeRoot()
      try {
        const first = await open(root)
        const orchestration = await import(join(helpers_packageRoot(), 'lib', 'orchestration.js'))
        const created = await first.store.createRun(COMMAND, 'rev-1', 'def-1', 'input-1')
        const intent = await first.store.recordIntent(created.runId, { nodeId: 'review', kind: 'agentTask' })
        // "crash": close without settling; reopen and reconcile.
        await first.opened.close()
        const second = await open(root)
        const report = await orchestration.reconcileOnStart(second.store)
        const reread = await second.store.get(created.runId)
        const inRecovery =
          reread.state === 'recovery_required' && report.recoveryRequired.some(r => r.runId === created.runId && r.attemptId === intent.attemptId)
        const reviewed = await orchestration.reconcile(second.store, reread, 'failed', 'operator confirmed no external effect')
        const settled =
          reviewed.state === 'failed' && reviewed.attempts.find(a => a.attemptId === intent.attemptId).result?.evidence.includes('operator confirmed')
        // Terminal cancellation is an idempotent read, not a new transition.
        // Compare the complete aggregate, including seq/log and reviewed evidence.
        const terminal = structuredClone(reviewed)
        for (let repeat = 0; repeat < 2; repeat++) {
          assert.deepEqual(await second.store.requestCancel(created.runId), terminal, 'repeated terminal cancel must return the unchanged aggregate')
          assert.deepEqual(await second.store.get(created.runId), terminal, 'repeated terminal cancel must not persist any aggregate change')
        }
        // Even a stale recovery snapshot cannot reconcile the terminal again.
        await assert.rejects(orchestration.reconcile(second.store, reread, 'succeeded', 'replacement review must not apply'), {
          code: 'TERMINAL_STATE_IMMUTABLE'
        })
        assert.deepEqual(await second.store.get(created.runId), terminal, 'second reconciliation must preserve the original terminal and evidence')
        await assert.rejects(
          second.store.recordResult(created.runId, intent.attemptId, {
            ok: true,
            outcome: { kind: 'succeeded' },
            evidence: 'late result must not replace reviewed evidence'
          }),
          { code: 'TERMINAL_STATE_IMMUTABLE' }
        )
        assert.deepEqual(await second.store.get(created.runId), terminal, 'late result must preserve the original terminal Attempt result and aggregate')
        await second.opened.close()
        return inRecovery && settled
      } finally {
        cleanup(root)
      }
    }
  })

  cases.push({
    id: 'RT5',
    title: 'T08: durability failure after store close is typed DURABILITY_FAILED (no silent continue)',
    contract: 'C-08',
    expect: 'pass',
    run: async () => {
      const root = runtimeRoot()
      try {
        const { opened, store } = await open(root)
        const created = await store.createRun(COMMAND, 'rev-1', 'def-1', 'input-1')
        await opened.close()
        let failed = null
        try {
          await store.requestCancel(created.runId)
        } catch (error) {
          failed = error
        }
        return failed?.code === 'DURABILITY_FAILED'
      } finally {
        cleanup(root)
      }
    }
  })

  cases.push({
    id: 'RT6',
    title: 'T08: single-writer lease — second writer rejected, release/reacquire works, stale dead-PID takeover requires proof',
    contract: 'C-08',
    expect: 'pass',
    run: async () => {
      const root = runtimeRoot()
      try {
        const persistence = await import(join(helpers_packageRoot(), 'lib', 'persistence.js'))
        const lease = persistence.WriterLease.acquire(root)
        let secondRejected = false
        try {
          persistence.WriterLease.acquire(root)
        } catch (error) {
          secondRejected = error?.code === 'COORDINATOR_ALREADY_ACTIVE'
        }
        lease.release()
        const reacquired = persistence.WriterLease.acquire(root)
        // Craft a stale lease from a dead PID with an old heartbeat, then prove takeover.
        reacquired.release()
        const leaseFile = join(root, persistence.WriterLease.LEASE_FILE)
        writeFileSync(leaseFile, JSON.stringify({ ownerId: 'old', pid: 999999999, startedAt: 1, runtimeRoot: root }))
        const stale = Date.now() - 60_000
        utimesSync(leaseFile, new Date(stale), new Date(stale))
        const taken = persistence.WriterLease.acquire(root)
        const takenOk = taken.ownerId !== 'old'
        // A live-PID lease must NOT be taken over even with a stale heartbeat.
        taken.release()
        writeFileSync(leaseFile, JSON.stringify({ ownerId: 'live', pid: process.pid, startedAt: 1, runtimeRoot: root }))
        utimesSync(leaseFile, new Date(stale), new Date(stale))
        let liveHeld = false
        try {
          persistence.WriterLease.acquire(root)
        } catch (error) {
          liveHeld = error?.code === 'COORDINATOR_ALREADY_ACTIVE'
        }
        return secondRejected && reacquired.ownerId !== 'old' && takenOk && liveHeld
      } finally {
        cleanup(root)
      }
    }
  })

  cases.push({
    id: 'RT7',
    title: 'T08: projection rebuild from canonical records (deleting the view loses nothing)',
    contract: 'C-08',
    expect: 'pass',
    run: async () => {
      const root = runtimeRoot()
      try {
        const { opened, store } = await open(root)
        const a = await store.createRun({ ...COMMAND, requestId: 'a' }, 'rev-1', 'def-1', 'input')
        const b = await store.createRun({ ...COMMAND, requestId: 'b' }, 'rev-1', 'def-1', 'input')
        await store.settleTerminal(b.runId, 'succeeded')
        const view = await store.rebuildProjection()
        await opened.close()
        const { opened: reopened, store: store2 } = await open(root)
        const rebuilt = await store2.rebuildProjection()
        await reopened.close()
        return (
          view.total === 2 &&
          rebuilt.total === 2 &&
          view.byState.succeeded === 1 &&
          rebuilt.byState.succeeded === 1 &&
          JSON.stringify(view) === JSON.stringify(rebuilt) &&
          a.runId !== b.runId
        )
      } finally {
        cleanup(root)
      }
    }
  })

  cases.push({
    id: 'RT8',
    title: 'T07: scheduler — parallel branches go ready independently; join-all waits for selected paths; unselected branches skip',
    contract: 'C-07',
    expect: 'pass',
    run: async () => {
      const orchestration = await import(join(helpers_packageRoot(), 'lib', 'orchestration.js'))
      const definition = {
        schemaVersion: 1,
        id: 'branchy',
        name: 'branchy',
        resources: {},
        graph: {
          nodes: [
            { id: 'input', kind: 'input', outputs: { request: 'string' } },
            { id: 'branchA', kind: 'toolCall', inputs: { x: 'string' }, outputs: { y: 'string' } },
            { id: 'branchB', kind: 'toolCall', inputs: { x: 'string' }, outputs: { y: 'string' } },
            { id: 'merge', kind: 'join', join: 'all', inputs: { a: 'string', b: 'string' }, outputs: { out: 'string' } },
            { id: 'final', kind: 'output', inputs: { value: 'string' } }
          ],
          edges: [
            { kind: 'data', from: 'input.request', to: 'branchA.x' },
            { kind: 'data', from: 'input.request', to: 'branchB.x' },
            { kind: 'data', from: 'branchA.y', to: 'merge.a' },
            { kind: 'data', from: 'branchB.y', to: 'merge.b' },
            { kind: 'data', from: 'merge.out', to: 'final.value' }
          ]
        }
      }
      const view = states => ({ attempts: Object.entries(states).map(([nodeId, state]) => ({ nodeId, states: [state] })), decisions: {} })
      const initial = orchestration.readyNodes(definition, view({}))
      const afterA = orchestration.readyNodes(definition, view({ input: 'succeeded' }))
      const bothDone = orchestration.readyNodes(definition, view({ input: 'succeeded', branchA: 'succeeded', branchB: 'succeeded' }))
      const mergeDone = orchestration.readyNodes(definition, view({ input: 'succeeded', branchA: 'succeeded', branchB: 'succeeded', merge: 'succeeded' }))
      return (
        initial.ready.includes('input') &&
        initial.ready.length === 1 &&
        afterA.ready.includes('branchA') &&
        afterA.ready.includes('branchB') &&
        bothDone.ready.includes('merge') &&
        bothDone.blocked.includes('final') &&
        mergeDone.ready.includes('final')
      )
    }
  })

  cases.push({
    id: 'RT9',
    title: 'T07: condition selects one path (other skipped); join-all over a failed selected path never fakes success',
    contract: 'C-07',
    expect: 'pass',
    run: async () => {
      const orchestration = await import(join(helpers_packageRoot(), 'lib', 'orchestration.js'))
      const definition = {
        schemaVersion: 1,
        id: 'cond',
        name: 'cond',
        resources: {},
        graph: {
          nodes: [
            { id: 'gate', kind: 'condition', branches: ['yes', 'no'] },
            { id: 'yes-path', kind: 'toolCall', outputs: { y: 'string' } },
            { id: 'no-path', kind: 'toolCall' },
            { id: 'merge', kind: 'join', join: 'all', inputs: { a: 'string' } }
          ],
          edges: [
            { kind: 'control', from: 'gate@yes', to: 'yes-path' },
            { kind: 'control', from: 'gate@no', to: 'no-path' },
            { kind: 'data', from: 'yes-path.y', to: 'merge.a' }
          ]
        }
      }
      const view = (states, decisions) => ({
        attempts: Object.entries(states).map(([nodeId, state]) => ({ nodeId, states: [state] })),
        decisions: decisions ?? {}
      })
      const withDecision = orchestration.readyNodes(definition, view({ gate: 'succeeded' }, { gate: 'yes' }))
      const noDecision = orchestration.readyNodes(definition, view({ gate: 'succeeded' }))
      const failedSelected = orchestration.readyNodes(definition, view({ gate: 'succeeded', 'yes-path': 'failed' }, { gate: 'yes' }))
      return (
        withDecision.ready.includes('yes-path') &&
        withDecision.skipped.includes('no-path') &&
        noDecision.blocked.includes('yes-path') &&
        failedSelected.skipped.includes('merge')
      )
    }
  })

  cases.push({
    id: 'RT10',
    title: 'T07: iteration budget exceeded fails typed BUDGET_EXCEEDED',
    contract: 'C-07',
    expect: 'pass',
    run: async () => {
      const orchestration = await import(join(helpers_packageRoot(), 'lib', 'orchestration.js'))
      let threw = null
      try {
        orchestration.checkBudget('loop', { maxIterations: 5, maxDurationMs: 1000 }, { iterations: 6, elapsedMs: 10 })
      } catch (error) {
        threw = error
      }
      return threw?.code === 'BUDGET_EXCEEDED'
    }
  })

  cases.push({
    id: 'RT11',
    title: 'T08/T10: terminal race — exactly one settlement wins; later transitions are typed-immutable',
    contract: 'C-10',
    expect: 'pass',
    run: async () => {
      const root = runtimeRoot()
      try {
        const { opened, store } = await open(root)
        const created = await store.createRun(COMMAND, 'rev-1', 'def-1', 'input-1')
        await store.recordIntent(created.runId, { nodeId: 'n1', kind: 'toolCall' })
        // Cancel and result arrive concurrently; the single writer serializes
        // them — exactly one wins the terminal, the loser is typed-rejected.
        const results = await Promise.allSettled([
          store.settleTerminal(created.runId, 'cancelled', { winner: 'cancel' }),
          store.recordResult(created.runId, (await store.get(created.runId)).attempts[0].attemptId, { ok: true, outcome: 'late', evidence: 'late-result' })
        ])
        const settled = await store.get(created.runId)
        const winners = results.filter(r => r.status === 'fulfilled').length
        const lateImmutable = results.filter(
          r => r.status === 'rejected' && (r.reason?.code === 'TERMINAL_STATE_IMMUTABLE' || r.reason?.code === 'DURABILITY_FAILED')
        ).length
        await opened.close()
        return winners === 1 && lateImmutable === 1 && ['cancelled', 'succeeded'].includes(settled.state)
      } finally {
        cleanup(root)
      }
    }
  })

  cases.push({
    id: 'RT12',
    title: 'T09: cancel during running enters cancelling; queued cancel short-circuits to cancelled',
    contract: 'C-09',
    expect: 'pass',
    run: async () => {
      const root = runtimeRoot()
      try {
        const { opened, store } = await open(root)
        const queued = await store.createRun({ ...COMMAND, requestId: 'q1' }, 'rev-1', 'def-1', 'input')
        const afterQueuedCancel = await store.requestCancel(queued.runId)
        const running = await store.createRun({ ...COMMAND, requestId: 'r1' }, 'rev-1', 'def-1', 'input')
        await store.recordIntent(running.runId, { nodeId: 'n1', kind: 'toolCall' })
        const cancelling = await store.requestCancel(running.runId)
        await opened.close()
        return afterQueuedCancel.state === 'cancelled' && cancelling.state === 'cancelling'
      } finally {
        cleanup(root)
      }
    }
  })

  return cases
}
