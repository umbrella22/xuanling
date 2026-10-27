import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { spawnSync } from 'node:child_process'
import { harness, runSaved, definition, agentNode, bindingResources, contentTool, executeTool, runArgs, drain } from '../runtime-contracts/agent-fixtures.mjs'
import { WorkspaceWriteLease } from '../../src/service/workspace-write-lease.ts'

test('T11b: two potential writers serialize against the project and preserve both updates', async t => {
  let active = 0,
    maximum = 0,
    h
  h = await harness(t, {
    config: { toolBindings: { writer: { tools: ['mutate'] } } },
    onTurn: async call => {
      maximum = Math.max(maximum, ++active)
      const previous = Number(readFileSync(join(call.options.meta.cwd, 'shared.txt'), 'utf8'))
      await nextTurn()
      await executeTool(call, 'mutate', { value: previous + 1 })
      active--
      call.finish()
    }
  })
  h.nativeTools.register(contentTool('mutate', ({ value }) => writeFileSync(join(h.root, 'shared.txt'), String(value))))
  writeFileSync(join(h.root, 'shared.txt'), '0')
  const { record } = await runSaved(
    h,
    definition([agentNode({ id: 'first', toolsetRefs: ['writeset'] }), agentNode({ id: 'second', toolsetRefs: ['writeset'] })], bindingResources)
  )
  assert.equal(record.state, 'succeeded')
  assert.equal(maximum, 1)
  assert.equal(readFileSync(join(h.root, 'shared.txt'), 'utf8'), '2')
  assert.equal(existsSync(join(h.root, '.xuanling', 'workspace-write', 'intent.json')), false)
})

test('T11b: external preimage conflict rejects the write tool and cannot report success', async t => {
  let h,
    writes = 0
  h = await harness(t, {
    config: { toolBindings: { writer: { tools: ['mutate'] } } },
    onTurn: async call => {
      writeFileSync(join(h.root, 'shared.txt'), 'external edit')
      await executeTool(call, 'mutate')
      call.finish()
    }
  })
  h.nativeTools.register(
    contentTool('mutate', () => {
      writes++
      writeFileSync(join(h.root, 'shared.txt'), 'overwritten')
    })
  )
  writeFileSync(join(h.root, 'shared.txt'), 'original')
  const { record } = await runSaved(h, definition([agentNode({ toolsetRefs: ['writeset'] })], bindingResources))
  assert.equal(record.state, 'failed')
  assert.equal(record.attempts[0].result.outcome.kind, 'workspace-conflict')
  assert.equal(writes, 0)
  assert.equal(readFileSync(join(h.root, 'shared.txt'), 'utf8'), 'external edit')
})

test('T11b: unresolved effect remains fenced after release and reacquisition', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bp-write-fence-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const first = await WorkspaceWriteLease.acquire(root, { runId: 'r1', attemptId: 'a1' }, new AbortController().signal)
  first.finish(false)
  await assert.rejects(
    () => WorkspaceWriteLease.acquire(root, { runId: 'r2', attemptId: 'a2' }, new AbortController().signal),
    error => error.code === 'workspace-recovery-required'
  )
  assert.equal(JSON.parse(readFileSync(join(root, '.xuanling', 'workspace-write', 'intent.json'))).runId, 'r1')
})

test('T11b: custom runtimeRoot preserves the explicit target cwd', async t => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'bp-runtime-location-'))
  t.after(() => rmSync(runtimeRoot, { recursive: true, force: true }))
  const h = await harness(t, { config: { runtimeRoot } })
  const doc = await h.save(definition())
  await h.service.startRun(runArgs(doc))
  await drain(h)
  assert.equal(h.host.calls[0].options.meta.cwd, realpathSync(h.root))
})

test('T11b: a second process cannot acquire an active workspace writer', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bp-cross-process-write-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const first = await WorkspaceWriteLease.acquire(root, { runId: 'r1', attemptId: 'a1' }, new AbortController().signal)
  try {
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-transform-types',
        '--input-type=module',
        '-e',
        `
      import {WorkspaceWriteLease} from ${JSON.stringify(new URL('../../src/service/workspace-write-lease.ts', import.meta.url).href)};
      try { const lease = await WorkspaceWriteLease.acquire(process.argv[1], {runId:'r2',attemptId:'a2'}, new AbortController().signal); lease.finish(true); process.exitCode=2 }
      catch(error) { if(error.code!=='workspace-write-busy') throw error; console.log(error.code) }
    `,
        root
      ],
      { encoding: 'utf8', timeout: 10000 }
    )
    assert.equal(child.status, 0, child.stderr)
    assert.match(child.stdout, /workspace-write-busy/)
  } finally {
    first.finish(true)
  }
})

test('T11b: cancellation while queued creates no write intent and preserves the owner', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bp-cancel-write-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const first = await WorkspaceWriteLease.acquire(root, { runId: 'r1', attemptId: 'a1' }, new AbortController().signal)
  const controller = new AbortController()
  const waiting = WorkspaceWriteLease.acquire(root, { runId: 'r2', attemptId: 'a2' }, controller.signal)
  controller.abort(new Error('cancelled'))
  await assert.rejects(waiting, /cancelled/)
  assert.equal(JSON.parse(readFileSync(join(root, '.xuanling', 'workspace-write', 'intent.json'))).runId, 'r1')
  first.finish(true)
  const third = await WorkspaceWriteLease.acquire(root, { runId: 'r3', attemptId: 'a3' }, new AbortController().signal)
  third.finish(true)
})

test('T11b: recovery needs explicit quiescence, matching owner and durable successful settlement', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bp-recover-write-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const owner = { runId: 'r1', attemptIds: ['a1'] }
  const confirmation = { quiescent: true, note: 'Operator checked task termination and partial writes' }
  const first = await WorkspaceWriteLease.acquire(root, { runId: owner.runId, attemptId: 'a1' }, new AbortController().signal)
  first.finish(false)
  const intent = join(root, '.xuanling', 'workspace-write', 'intent.json')
  await assert.rejects(() => WorkspaceWriteLease.reconcile(root, owner, { ...confirmation, quiescent: false }, async () => assert.fail('must not settle')), {
    code: 'workspace-recovery-required'
  })
  await assert.rejects(
    () => WorkspaceWriteLease.reconcile(root, { ...owner, attemptIds: ['wrong'] }, confirmation, async () => assert.fail('must not settle')),
    { code: 'workspace-recovery-required' }
  )
  await assert.rejects(
    () =>
      WorkspaceWriteLease.reconcile(root, owner, confirmation, async () => {
        throw new Error('disk full')
      }),
    /disk full/
  )
  assert.equal(existsSync(intent), true)
  assert.equal(await WorkspaceWriteLease.reconcile(root, owner, confirmation, async () => 'settled'), 'settled')
  assert.equal(existsSync(intent), false)
  const next = await WorkspaceWriteLease.acquire(root, { runId: 'r2', attemptId: 'a2' }, new AbortController().signal)
  next.finish(true)
})

test('T11b: separate runtime roots serialize on the same physical workspace', async t => {
  let active = 0,
    maximum = 0
  const onTurn = async call => {
    maximum = Math.max(maximum, ++active)
    const before = Number(readFileSync(join(call.options.meta.cwd, 'shared.txt'), 'utf8'))
    await nextTurn()
    await executeTool(call, 'mutate', { value: before + 1 })
    active--
    call.finish()
  }
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers()
  const one = await harness(t, {
    onTurn: async call => {
      entered.resolve()
      await release.promise
      await onTurn(call)
    },
    config: { toolBindings: { writer: { tools: ['mutate'] } } }
  })
  const two = await harness(t, { onTurn, config: { workspaceRoot: one.root, toolBindings: { writer: { tools: ['mutate'] } } } })
  for (const h of [one, two]) h.nativeTools.register(contentTool('mutate', ({ value }) => writeFileSync(join(one.root, 'shared.txt'), String(value))))
  writeFileSync(join(one.root, 'shared.txt'), '0')
  const doc = await one.save(definition([agentNode({ toolsetRefs: ['writeset'] })], bindingResources))
  await one.service.startRun(runArgs(doc))
  await entered.promise
  await two.service.startRun(runArgs(doc))
  release.resolve()
  await Promise.all([drain(one), drain(two)])
  assert.equal(maximum, 1)
  assert.equal(readFileSync(join(one.root, 'shared.txt'), 'utf8'), '2')
})
