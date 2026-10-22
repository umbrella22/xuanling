/** W3 configured-ID/document-CAS source regressions. Isolated fixtures, no profile/key/build. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createMessage } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { readZip, writeZip } from '../../src/portability/zip.ts'
import { BlueprintService } from '../../src/index.ts'
import { TYPERT } from '../../src/typert.host.ts'
import * as persist from '../../src/definition/persist.ts'
import { decodeDefinition, validateDefinition } from '../../src/definition/index.ts'
import { acquireLibraryWriter } from '../../src/definition/library-state.ts'

const doc = (more = {}) => ({
  schemaVersion: 2,
  id: 'sample',
  name: 'Actual configured blueprint',
  resources: {},
  graph: {
    nodes: [
      { id: 'input', kind: 'input', outputs: { value: 'json' } },
      { id: 'output', kind: 'output', inputs: { value: 'json' } }
    ],
    edges: [{ kind: 'data', from: 'input.value', to: 'output.value' }]
  },
  presentation: { nodes: { input: { x: 0, y: 0 }, output: { x: 200, y: 0 } } },
  ...more
})
const codec = method => TYPERT.invocations.find(i => i.method === method)?.parameters[0]?.codec.create()
async function fixture(t, { missing = false, empty = false, host } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bp-w3-doc-'))
  const rootDir = join(root, '.xuanling', 'workflows', 'sample')
  const runtimeRoot = join(root, '.xuanling')
  mkdirSync(rootDir, { recursive: true })
  if (!missing && !empty) writeFileSync(join(rootDir, 'blueprint.json'), JSON.stringify(doc()))
  const ctx = new Context()
  ctx.provide('systemPrompt', {
    tools() {
      return () => {}
    }
  })
  new ToolRuntime(ctx, { mode: 'native' })
  if (host) {
    host.attach(ctx)
    ctx.provide('agents', host.registry)
  }
  const config = { workspaceRoot: root, runtimeRoot, skillRoots: [] }
  const fiber = await ctx.plugin(BlueprintService, config)
  const service = ctx.blueprint
  t.after(async () => {
    await fiber.dispose()
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  return { service, root, rootDir, runtimeRoot, config, fiber }
}
const deferred = () => {
  let resolve
  const promise = new Promise(done => {
    resolve = done
  })
  return { promise, resolve }
}
const requireDocumentApi = service => {
  for (const method of ['listDefinitions', 'loadDefinition', 'saveDefinition'])
    assert.equal(typeof service[method], 'function', `TARGET: public ${method} is implemented`)
}
async function drain(service) {
  for (const handle of service.runtimes.values()) {
    await handle.admissionTail
    while (handle.jobs.size) await Promise.all(handle.jobs.values())
  }
}
const publicArgs = {
  loadDefinition: { blueprintId: 'sample' },
  saveDefinition: { blueprintId: 'sample', definitionJson: JSON.stringify(doc()), expectedRevision: null },
  validate: { definitionJson: JSON.stringify(doc()) },
  startRun: { blueprintId: 'sample', expectedRevision: 'document', inputJson: '{}', requestId: 'request' },
  inspectRun: { runId: 'run' },
  cancelRun: { runId: 'run' },
  decide: { runId: 'run', decisionId: 'decision', action: 'approve' },
  exportDefinition: { blueprintId: 'sample' },
  importDefinition: { blueprintId: 'sample', archiveBase64: 'YQ==' }
}
for (const [method, args] of Object.entries(publicArgs)) {
  test(`wire ${method}: rejects unknown locator fields without silently stripping`, () => {
    const schema = codec(method)
    assert.ok(schema, `TARGET: ${method} has public parameter codec`)
    assert.equal(schema.safeParse({ ...args, rootDir: '/UNTRUSTED_LOCATOR' }).success, false, `TARGET: ${method} rejects unknown rootDir`)
    assert.equal(schema.safeParse({ ...args, surprise: 'ignored?' }).success, false, `TARGET: ${method} rejects any unknown field`)
    const valid = schema.safeParse(args)
    assert.equal(valid.success, true, `TARGET: ${method} accepts the frozen valid DTO`)
    assert.deepEqual(valid.data, args, `TARGET: ${method} preserves the frozen valid DTO`)
  })
}
test('service catalog: empty config is empty, missing configured document has null revisions', async t => {
  const h = await fixture(t, { empty: true })
  requireDocumentApi(h.service)
  assert.deepEqual(await h.service.listDefinitions(), { definitions: [] })
  await assert.rejects(h.service.loadDefinition({ blueprintId: 'sample' }), { code: 'blueprint/definition-not-found' })
  assert.equal(existsSync(join(h.rootDir, 'blueprint.json')), false)
})
test('service document CAS: layout-only changes conflict without changing semantic, stale write preserves file', async t => {
  const h = await fixture(t)
  requireDocumentApi(h.service)
  const loaded = await h.service.loadDefinition({ blueprintId: 'sample' })
  assert.ok(loaded.documentRevision)
  const changed = doc({ presentation: { nodes: { input: { x: 10, y: 20 }, output: { x: 200, y: 0 } } } })
  const saved = await h.service.saveDefinition({ blueprintId: 'sample', expectedRevision: loaded.documentRevision, definitionJson: JSON.stringify(changed) })
  assert.equal(saved.semanticRevision, loaded.semanticRevision)
  assert.notEqual(saved.layoutRevision, loaded.layoutRevision)
  assert.notEqual(saved.documentRevision, loaded.documentRevision)
  const bytes = readFileSync(join(h.rootDir, 'blueprint.json'))
  await assert.rejects(
    h.service.saveDefinition({
      blueprintId: 'sample',
      expectedRevision: loaded.documentRevision,
      definitionJson: JSON.stringify(doc({ name: 'STALE_REPLACEMENT' }))
    }),
    { code: 'blueprint/revision-conflict' }
  )
  assert.deepEqual(readFileSync(join(h.rootDir, 'blueprint.json')), bytes)
  assert.deepEqual(await h.service.loadDefinition({ blueprintId: 'sample' }), saved)
  assert.deepEqual(
    await h.service.saveDefinition({ blueprintId: 'sample', expectedRevision: saved.documentRevision, definitionJson: saved.definitionJson }),
    saved
  )
})
test('service start: only configured saved document, document CAS, real input and output projection', async t => {
  const h = await fixture(t)
  requireDocumentApi(h.service)
  const loaded = await h.service.loadDefinition({ blueprintId: 'sample' })
  await assert.rejects(h.service.startRun({ blueprintId: 'sample', expectedRevision: 'stale', inputJson: '{}', requestId: 'wrong' }), {
    code: 'blueprint/revision-conflict'
  })
  const admitted = await h.service.startRun({
    blueprintId: 'sample',
    expectedRevision: loaded.documentRevision,
    inputJson: '{"actual":42}',
    requestId: randomUUID()
  })
  assert.equal(admitted.semanticRevision, loaded.semanticRevision)
  await drain(h.service)
  const inspected = await h.service.inspectRun({ runId: admitted.runId })
  assert.equal(inspected.state, 'succeeded')
  assert.deepEqual(JSON.parse(inspected.attempts.find(a => a.nodeId === 'output').outputJson), { outputs: {}, value: { value: { actual: 42 } } })
  const run = await [...h.service.runtimes.values()][0].store.get(admitted.runId)
  assert.deepEqual(JSON.parse(run.definitionJson), JSON.parse(loaded.definitionJson))
  assert.equal(run.inputRef, '{"actual":42}')
})
test('service first save: absent-only null CAS, ID/schema mismatch no overwrite or raw leakage', async t => {
  const h = await fixture(t, { missing: true })
  requireDocumentApi(h.service)
  const saved = await h.service.saveDefinition({ blueprintId: 'sample', expectedRevision: null, definitionJson: JSON.stringify(doc()) })
  await assert.rejects(h.service.saveDefinition({ blueprintId: 'sample', expectedRevision: null, definitionJson: saved.definitionJson }), {
    code: 'blueprint/revision-conflict'
  })
  const before = readFileSync(join(h.rootDir, 'blueprint.json'))
  for (const definitionJson of [JSON.stringify(doc({ id: 'other' })), 'RAW_DOCUMENT_SECRET_INVALID_JSON']) {
    await assert.rejects(h.service.saveDefinition({ blueprintId: 'sample', expectedRevision: saved.documentRevision, definitionJson }), error => {
      assert.equal(error.code, 'blueprint/definition-invalid')
      assert.equal(JSON.stringify(error).includes('RAW_DOCUMENT_SECRET'), false)
      assert.equal(JSON.stringify(error).includes(h.root), false)
      return true
    })
  }
  assert.deepEqual(readFileSync(join(h.rootDir, 'blueprint.json')), before)
})
test('legacy helper: semantic expectedRevision stays distinct from new document CAS', async t => {
  const h = await fixture(t, { missing: true })
  const original = decodeDefinition(JSON.stringify(doc()))
  validateDefinition(original)
  const first = persist.saveDefinition(h.rootDir, original, { expectedRevision: null })
  const moved = doc({ presentation: { nodes: { input: { x: 50, y: 20 } } } })
  const second = persist.saveDefinition(h.rootDir, moved, { expectedRevision: first.revision.semantic })
  assert.equal(second.revision.semantic, first.revision.semantic)
})

test('admission closure race: accepted document revision freezes exactly its package bytes', async t => {
  const h = await fixture(t)
  mkdirSync(join(h.rootDir, 'lib'))
  const asset = join(h.rootDir, 'lib', 'asset.txt')
  writeFileSync(asset, 'PACKAGE-A')
  const loaded = await h.service.loadDefinition({ blueprintId: 'sample' })
  const runtimeFor = h.service.runtimeFor.bind(h.service)
  h.service.runtimeFor = async (...args) => {
    // A real asynchronous opening boundary, after CAS read and before freeze.
    writeFileSync(asset, 'PACKAGE-B')
    return await runtimeFor(...args)
  }
  const admitted = await h.service.startRun({ blueprintId: 'sample', expectedRevision: loaded.documentRevision, inputJson: '{}', requestId: 'closure-race' })
  await drain(h.service)
  const bundle = JSON.parse(readFileSync(join(h.runtimeRoot, 'snapshots', admitted.runId, 'package.json')))
  const frozen = bundle.files.find(file => file.path === 'lib/asset.txt')
  assert.ok(frozen, 'TARGET: complete package asset is frozen')
  assert.equal(Buffer.from(frozen.base64, 'base64').toString(), 'PACKAGE-A', 'TARGET: accepted revision A must not freeze later external lib B')
  assert.equal(admitted.semanticRevision, loaded.semanticRevision)
})
test('admission requestId replay: returns canonical original Run revision after external lib change', async t => {
  const h = await fixture(t)
  mkdirSync(join(h.rootDir, 'lib'))
  const asset = join(h.rootDir, 'lib', 'asset.txt')
  writeFileSync(asset, 'PACKAGE-A')
  const loaded = await h.service.loadDefinition({ blueprintId: 'sample' })
  const args = { blueprintId: 'sample', expectedRevision: loaded.documentRevision, inputJson: '{}', requestId: 'closure-replay' }
  const first = await h.service.startRun(args)
  await drain(h.service)
  const before = readFileSync(join(h.runtimeRoot, 'snapshots', first.runId, 'package.json'))
  writeFileSync(asset, 'PACKAGE-B')
  const changed = await h.service.loadDefinition({ blueprintId: 'sample' })
  assert.notEqual(changed.semanticRevision, loaded.semanticRevision)
  const second = await h.service.startRun({ ...args, expectedRevision: changed.documentRevision })
  const canonical = await h.service.inspectRun({ runId: second.runId })
  assert.equal(second.runId, first.runId)
  assert.equal(second.replayed, true)
  assert.equal(second.semanticRevision, canonical.definitionRevision, 'TARGET: replay admission must not claim the newer unfrozen package revision')
  assert.equal(second.semanticRevision, first.semanticRevision)
  assert.deepEqual(readFileSync(join(h.runtimeRoot, 'snapshots', first.runId, 'package.json')), before)
})

const resultCodec = method => TYPERT.invocations.find(i => i.method === method).result.create()
const safeError = (code, root) => error => {
  assert.equal(error.code, code)
  assert.equal(JSON.stringify({ code: error.code, message: error.message, details: error.details }).includes(root), false)
  assert.equal(JSON.stringify(error).includes('EXTERNAL_SENTINEL_CANARY'), false)
  return true
}
function hostRegistry(onDispatch = call => call.finish({ kind: 'completed' }, 'REAL_OUTPUT')) {
  const calls = []
  let parentCtx
  return {
    calls,
    attach(ctx) {
      parentCtx = ctx
    },
    registry: {
      async create(options) {
        options.signal?.throwIfAborted()
        const id = SessionId(options.sessionId)
        const session = Session.create(
          id,
          options.seed,
          { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), isSeeded: false, ...options.meta },
          options.inheritedEventCount
        )
        let running = false
        const idle = Promise.withResolvers()
        const call = {
          options,
          session,
          injections: [],
          input: '',
          finish(reason, output = '') {
            if (!running) return
            if (output)
              session.append(
                'assistant/message',
                { turn: 1, step: 1, stream: [], message: createMessage({ role: 'assistant', content: [{ type: 'text', text: output }] }) },
                { surfaceOp: 'append' }
              )
            session.append('turn/end', { turn: 1, reason })
            running = false
            idle.resolve()
          }
        }
        const agent = {
          session,
          inject(message) {
            call.injections.push(message.content.map(b => (b.type === 'text' ? b.text : '')).join(''))
          },
          followup(message) {
            running = true
            session.append('turn/start', { turn: 1 })
            session.append('user/message', message, { surfaceOp: 'append' })
            call.input = message.content.map(b => (b.type === 'text' ? b.text : '')).join('')
            onDispatch(call)
          },
          whenIdle() {
            return running ? idle.promise : Promise.resolve()
          },
          cancel(cause) {
            call.finish({ kind: 'aborted', cause })
          }
        }
        // Real public Agent scope: unscoped ToolRuntime.restrict is forbidden.
        const scope = createScope(parentCtx, agent)
        agent.ctx = scope.ctx
        try {
          const publication = await options.setup?.(scope.ctx, agent)
          options.signal?.throwIfAborted()
          publication?.commit()
        } catch (error) {
          await scope.dispose()
          throw error
        }
        calls.push(call)
        let disposed = false
        return {
          agent,
          async dispose() {
            if (disposed) return
            agent.cancel({ kind: 'disposed' })
            await agent.whenIdle()
            await scope.dispose()
            disposed = true
          }
        }
      }
    }
  }
}

test('document CAS: concurrent layout writers have one winner and retain the complete winner', async t => {
  const h = await fixture(t)
  const loaded = await h.service.loadDefinition({ blueprintId: 'sample' })
  const edits = [100, 200].map(x => doc({ presentation: { nodes: { input: { x, y: 5 } } } }))
  const results = await Promise.allSettled(
    edits.map(d => h.service.saveDefinition({ blueprintId: 'sample', definitionJson: JSON.stringify(d), expectedRevision: loaded.documentRevision }))
  )
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.filter(r => r.status === 'rejected').length, 1)
  const winner = results.find(r => r.status === 'fulfilled').value
  const loser = results.find(r => r.status === 'rejected').reason
  assert.equal(loser.code, 'blueprint/revision-conflict')
  assert.deepEqual(loser.details, { blueprintId: 'sample', expectedRevision: loaded.documentRevision, actualRevision: winner.documentRevision })
  assert.deepEqual(await h.service.loadDefinition({ blueprintId: 'sample' }), winner)
  assert.deepEqual(JSON.parse(readFileSync(join(h.rootDir, 'blueprint.json'), 'utf8')), JSON.parse(winner.definitionJson))
  assert.equal(winner.semanticRevision, loaded.semanticRevision)
})

test('document queue: physical root aliases serialize facade saves and rejected actions do not poison later writes', async t => {
  const h = await fixture(t)
  const loaded = await h.service.loadDefinition({ blueprintId: 'sample' })
  const alias = join(h.root, 'queue-alias')
  symlinkSync(h.rootDir, alias)
  const entered = deferred(),
    release = deferred()
  // Hold the real production queue across an async boundary; facade save must
  // join it even after the same configured ID changes to a physical-root alias.
  const held = h.service.withDocument(h.rootDir, async () => {
    entered.resolve()
    await release.promise
  })
  let saving
  try {
    await entered.promise
    const before = readFileSync(join(h.rootDir, 'blueprint.json'))
    let settled = false
    saving = h.service
      .saveDefinition({
        blueprintId: 'sample',
        expectedRevision: loaded.documentRevision,
        definitionJson: JSON.stringify(doc({ name: 'After alias queue' }))
      })
      .finally(() => {
        settled = true
      })
    await new Promise(setImmediate)
    assert.equal(settled, false, 'alias facade save waits for the physical-root queue')
    assert.deepEqual(readFileSync(join(h.rootDir, 'blueprint.json')), before, 'queued save has no early file side effect')
  } finally {
    release.resolve()
    await Promise.allSettled([held, saving])
  }
  const saved = await saving
  assert.deepEqual(await h.service.loadDefinition({ blueprintId: 'sample' }), saved)
  assert.equal(JSON.parse(saved.definitionJson).name, 'After alias queue')
  assert.deepEqual(JSON.parse(readFileSync(join(h.rootDir, 'blueprint.json'), 'utf8')), JSON.parse(saved.definitionJson))
  await assert.rejects(h.service.saveDefinition({ blueprintId: 'sample', expectedRevision: loaded.documentRevision, definitionJson: loaded.definitionJson }), {
    code: 'blueprint/revision-conflict'
  })

  const failedEntered = deferred(),
    failRelease = deferred()
  const failure = new Error('isolated queue action rejected')
  const rejected = h.service.withDocument(alias, async () => {
    failedEntered.resolve()
    await failRelease.promise
    throw failure
  })
  const rejection = assert.rejects(rejected, error => error === failure)
  let retry
  try {
    await failedEntered.promise
    let settled = false
    retry = h.service
      .saveDefinition({
        blueprintId: 'sample',
        expectedRevision: saved.documentRevision,
        definitionJson: JSON.stringify(doc({ name: 'After rejected queue action' }))
      })
      .finally(() => {
        settled = true
      })
    await new Promise(setImmediate)
    assert.equal(settled, false, 'later facade write joins the pending action before its rejection')
  } finally {
    failRelease.resolve()
    await Promise.allSettled([rejection, retry])
  }
  await rejection
  const recovered = await retry
  assert.equal(JSON.parse(recovered.definitionJson).name, 'After rejected queue action')
  assert.deepEqual(await h.service.loadDefinition({ blueprintId: 'sample' }), recovered)
  assert.deepEqual(JSON.parse(readFileSync(join(h.rootDir, 'blueprint.json'), 'utf8')), JSON.parse(recovered.definitionJson))
})

test('document library drain: actual service disposal waits for an entered library mutation and releases its writer lease', async t => {
  const h = await fixture(t)
  const entered = deferred(),
    release = deferred(),
    events = []
  const marker = join(h.rootDir, 'drain-result.txt')
  const mutation = h.service.withDocument(
    h.rootDir,
    async () => {
      events.push('mutation-entered')
      entered.resolve()
      await release.promise
      writeFileSync(marker, 'COMPLETE_LIBRARY_MUTATION')
      events.push('mutation-complete')
    },
    true
  )
  let disposal
  try {
    await entered.promise
    const libraryRoot = join(h.root, '.xuanling', 'workflows')
    assert.throws(() => acquireLibraryWriter(libraryRoot), { code: 'COORDINATOR_ALREADY_ACTIVE' })
    let disposed = false
    disposal = h.fiber.dispose().then(() => {
      disposed = true
      events.push('disposed')
    })
    await new Promise(setImmediate)
    assert.equal(h.service.closing, true, 'actual service cleanup has entered its closing path')
    assert.equal(disposed, false, 'service disposal cannot finish before the library write')
    assert.equal(existsSync(marker), false)
  } finally {
    release.resolve()
    await Promise.allSettled([mutation, disposal])
  }
  await mutation
  await disposal
  assert.deepEqual(events, ['mutation-entered', 'mutation-complete', 'disposed'])
  assert.equal(readFileSync(marker, 'utf8'), 'COMPLETE_LIBRARY_MUTATION')
  const lease = acquireLibraryWriter(join(h.root, '.xuanling', 'workflows'))
  lease.release()
})

test('catalog IDs and strict service codecs: no prototype lookup, no untrusted locator or inline fallback', async t => {
  const h = await fixture(t)
  for (const blueprintId of ['toString', 'constructor', '__proto__', 'unconfigured']) {
    await assert.rejects(h.service.loadDefinition({ blueprintId }), safeError('blueprint/definition-not-found', h.root))
  }
  for (const [method, args] of Object.entries(publicArgs)) {
    await assert.rejects(h.service[method]({ ...args, surprise: true }), safeError('gateway/bad-request', h.root))
  }
  assert.equal(codec('startRun').safeParse({ definitionJson: JSON.stringify(doc()), inputJson: '{}', runtimeRoot: h.runtimeRoot }).success, false)
  assert.equal(
    TYPERT.invocations.some(i => i.method === 'hostProbe' || i.method === 'mcpProbe'),
    false,
    'diagnostic probes are internal-only, not public wire methods'
  )
  assert.equal(TYPERT.invocations.find(i => i.method === 'listDefinitions').parameters.length, 0)
})

test('document failure: file-shaped root and unreadable document are not treated as absent first save', async t => {
  const h = await fixture(t)
  rmSync(join(h.rootDir, 'blueprint.json'))
  mkdirSync(join(h.rootDir, 'blueprint.json'))
  await assert.rejects(
    h.service.saveDefinition({ blueprintId: 'sample', expectedRevision: null, definitionJson: JSON.stringify(doc()) }),
    safeError('blueprint/definition-write-failed', h.root)
  )
  assert.equal(existsSync(join(h.rootDir, 'blueprint.json')), true)
  const fileRoot = join(h.root, 'file-workspace')
  mkdirSync(join(fileRoot, '.xuanling'), { recursive: true })
  const workflowFile = join(fileRoot, '.xuanling', 'workflows')
  writeFileSync(workflowFile, 'UNCHANGED_FILE')
  h.config.workspaceRoot = fileRoot
  await assert.rejects(h.service.listDefinitions(), safeError('blueprint/definition-write-failed', h.root))
  assert.equal(readFileSync(workflowFile, 'utf8'), 'UNCHANGED_FILE')
})

for (const kind of ['definition', 'lib-root', 'lib-file', 'declared-resource']) {
  test(`package boundary ${kind}: load/save/start/export reject escape, leave original aggregate intact`, async t => {
    const h = await fixture(t)
    const loaded = await h.service.loadDefinition({ blueprintId: 'sample' })
    const sentinel = join(h.root, 'outside')
    mkdirSync(sentinel)
    const external = join(sentinel, 'sentinel.txt')
    writeFileSync(external, 'EXTERNAL_SENTINEL_CANARY')
    if (kind === 'definition') {
      const externalDoc = join(sentinel, 'blueprint.json')
      writeFileSync(externalDoc, JSON.stringify(doc()))
      rmSync(join(h.rootDir, 'blueprint.json'))
      symlinkSync(externalDoc, join(h.rootDir, 'blueprint.json'))
    } else if (kind === 'lib-root') symlinkSync(sentinel, join(h.rootDir, 'lib'))
    else {
      mkdirSync(join(h.rootDir, 'lib'))
      symlinkSync(external, join(h.rootDir, 'lib', 'escape.txt'))
      if (kind === 'declared-resource')
        writeFileSync(join(h.rootDir, 'blueprint.json'), JSON.stringify(doc({ resources: { prompt: { kind: 'prompt', path: 'lib/escape.txt' } } })))
    }
    const before = readFileSync(join(h.rootDir, 'blueprint.json'))
    for (const [method, args] of [
      ['loadDefinition', { blueprintId: 'sample' }],
      ['saveDefinition', { blueprintId: 'sample', expectedRevision: loaded.documentRevision, definitionJson: loaded.definitionJson }],
      ['startRun', { blueprintId: 'sample', expectedRevision: loaded.documentRevision, inputJson: '{}', requestId: kind }],
      ['exportDefinition', { blueprintId: 'sample' }]
    ]) {
      await assert.rejects(h.service[method](args), error => {
        assert.ok(['blueprint/definition-invalid', 'blueprint/definition-write-failed'].includes(error.code))
        assert.equal(JSON.stringify({ message: error.message, details: error.details }).includes(h.root), false)
        assert.equal(JSON.stringify(error).includes('EXTERNAL_SENTINEL_CANARY'), false)
        return true
      })
    }
    assert.deepEqual(readFileSync(join(h.rootDir, 'blueprint.json')), before)
    assert.equal(readFileSync(external, 'utf8'), 'EXTERNAL_SENTINEL_CANARY')
    assert.equal(h.service.runtimes.size, 0)
  })
}

test('configured root alias and internal file symlink: ordinary bytes work without machine paths in documents', async t => {
  const h = await fixture(t)
  const alias = join(h.root, 'alias')
  symlinkSync(h.rootDir, alias)
  mkdirSync(join(h.rootDir, 'lib'))
  writeFileSync(join(h.rootDir, 'lib', 'actual.txt'), 'INTERNAL_BYTES')
  symlinkSync(join(h.rootDir, 'lib', 'actual.txt'), join(h.rootDir, 'lib', 'link.txt'))
  const loaded = await h.service.loadDefinition({ blueprintId: 'sample' })
  assert.equal(resultCodec('loadDefinition').safeParse(loaded).success, true)
  assert.equal(JSON.stringify(loaded).includes(h.root), false)
  const admitted = await h.service.startRun({ blueprintId: 'sample', expectedRevision: loaded.documentRevision, inputJson: '{}', requestId: 'internal-link' })
  await drain(h.service)
  const bundle = JSON.parse(readFileSync(join(h.runtimeRoot, 'snapshots', admitted.runId, 'package.json')))
  assert.equal(Buffer.from(bundle.files.find(f => f.path === 'lib/link.txt').base64, 'base64').toString(), 'INTERNAL_BYTES')
})

test('public runtime uses the workspace-native directory when runtimeRoot is omitted', async t => {
  const h = await fixture(t)
  h.config.runtimeRoot = undefined
  const loaded = await h.service.loadDefinition({ blueprintId: 'sample' })
  const admitted = await h.service.startRun({
    blueprintId: 'sample',
    expectedRevision: loaded.documentRevision,
    inputJson: '{}',
    requestId: 'workspace-runtime'
  })
  await drain(h.service)
  assert.equal((await h.service.inspectRun({ runId: admitted.runId })).state, 'succeeded')
  assert.ok(existsSync(join(h.root, '.xuanling', 'runs', admitted.runId, 'run.json')))
  await assert.rejects(h.service.inspectRun({ runId: 'unknown' }), { code: 'blueprint/run-not-found' })
})

test('portable archive bytes: configured Skill closure roundtrips to empty configured root, no locators or shared write', async t => {
  const h = await fixture(t)
  const shared = join(h.root, 'shared')
  const skill = join(shared, 'demo')
  mkdirSync(join(skill, 'helpers'), { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), 'SHARED_SKILL_A')
  writeFileSync(join(skill, 'helpers', 'tool.txt'), 'COMPLETE_CLOSURE')
  h.config.skillRoots = [{ rootId: 'user-skills', rootPath: shared }]
  writeFileSync(
    join(h.rootDir, 'blueprint.json'),
    JSON.stringify(doc({ resources: { skill: { kind: 'skill', source: { kind: 'shared', rootId: 'user-skills', path: 'demo' } } } }))
  )
  const exported = await h.service.exportDefinition({ blueprintId: 'sample' })
  assert.equal(resultCodec('exportDefinition').safeParse(exported).success, true)
  assert.equal('archivePath' in exported, false)
  const archive = Buffer.from(exported.archiveBase64, 'base64')
  assert.equal(createHash('sha256').update(archive).digest('hex'), exported.archiveSha256)
  const files = new Map(readZip(archive).map(e => [e.name, e.data]))
  assert.equal(files.get('lib/skills/skill/helpers/tool.txt').toString(), 'COMPLETE_CLOSURE')
  assert.deepEqual(JSON.parse(files.get('blueprint.json')).resources.skill, { kind: 'skill', path: 'lib/skills/skill' })
  assert.equal(archive.includes(Buffer.from(h.root)), false)
  const targetWorkspace = join(h.root, 'empty-destination-workspace')
  const target = join(targetWorkspace, '.xuanling', 'workflows')
  mkdirSync(target, { recursive: true })
  h.config.workspaceRoot = targetWorkspace
  const imported = await h.service.importDefinition({ blueprintId: 'sample', archiveBase64: exported.archiveBase64 })
  assert.equal(resultCodec('importDefinition').safeParse(imported).success, true)
  assert.equal(imported.closureDigest, exported.closureDigest)
  assert.equal(imported.filesWritten, files.size)
  assert.equal('targetDir' in imported, false)
  const reopened = await h.service.loadDefinition({ blueprintId: 'sample' })
  assert.deepEqual(JSON.parse(reopened.definitionJson), JSON.parse(files.get('blueprint.json')))
  const importedHistory = await h.service.workflowRevisions({ workflowId: 'sample' })
  assert.equal(importedHistory.revisions.length, 1)
  assert.equal(importedHistory.revisions[0].origin, 'import')
  assert.equal(importedHistory.revisions[0].revision, reopened.documentRevision)
  assert.equal(readFileSync(join(skill, 'SKILL.md'), 'utf8'), 'SHARED_SKILL_A')
  assert.equal(readFileSync(join(skill, 'helpers', 'tool.txt'), 'utf8'), 'COMPLETE_CLOSURE')
  const before = readFileSync(join(target, 'sample', 'blueprint.json'))
  await assert.rejects(h.service.importDefinition({ blueprintId: 'sample', archiveBase64: exported.archiveBase64 }), error => {
    safeError('blueprint/import-failed', h.root)(error)
    assert.equal(error.details.code, 'IMPORT_CONFLICT')
    return true
  })
  assert.deepEqual(readFileSync(join(target, 'sample', 'blueprint.json')), before)
})

test('import/export failure bytes are rejected with safe codes and no destination writes', async t => {
  const h = await fixture(t)
  const exported = await h.service.exportDefinition({ blueprintId: 'sample' })
  const archive = Buffer.from(exported.archiveBase64, 'base64')
  const badDigest = writeZip(
    readZip(archive).map(e => ({
      name: e.name,
      data: e.name === 'blueprint.json' ? Buffer.from(JSON.stringify(doc({ name: 'EXTERNAL_SENTINEL_CANARY' }))) : e.data
    }))
  )
  const targetWorkspace = join(h.root, 'absent-destination-workspace')
  const target = join(targetWorkspace, '.xuanling', 'workflows')
  h.config.workspaceRoot = targetWorkspace
  for (const archiveBase64 of ['!invalid-base64', 'YQ==', badDigest.toString('base64')]) {
    await assert.rejects(h.service.importDefinition({ blueprintId: 'sample', archiveBase64 }), safeError('blueprint/import-failed', h.root))
    assert.equal(existsSync(target), false)
  }
  await assert.rejects(
    h.service.importDefinition({ blueprintId: 'other', archiveBase64: exported.archiveBase64 }),
    safeError('blueprint/import-failed', h.root)
  )
  assert.equal(existsSync(join(target, 'other')), false)
  h.config.workspaceRoot = h.root
  writeFileSync(
    join(h.rootDir, 'blueprint.json'),
    JSON.stringify(doc({ resources: { unavailable: { kind: 'skill', source: { kind: 'shared', rootId: 'missing-root', path: 'demo' } } } }))
  )
  await assert.rejects(h.service.exportDefinition({ blueprintId: 'sample' }), safeError('blueprint/export-failed', h.root))
})

test('hostProbe logical configured Skill: real public Agent/session contract and complete Skill directory', async t => {
  const host = hostRegistry(call => {
    call.file = readFileSync(join(call.options.meta.cwd, 'helpers', 'data.txt'), 'utf8')
    call.finish({ kind: 'completed' }, 'CONFIGURED_PROBE')
  })
  const h = await fixture(t, { host })
  const shared = join(h.root, 'shared')
  const skill = join(shared, 'demo')
  mkdirSync(join(skill, 'helpers'), { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), 'SKILL_CONTENT')
  writeFileSync(join(skill, 'helpers', 'data.txt'), 'WHOLE_SKILL_TREE')
  h.config.skillRoots = [{ rootId: 'user-skills', rootPath: shared }]
  writeFileSync(
    join(h.rootDir, 'blueprint.json'),
    JSON.stringify(doc({ resources: { probeSkill: { kind: 'skill', source: { kind: 'shared', rootId: 'user-skills', path: 'demo' } } } }))
  )
  const evidence = await h.service.hostProbe({ blueprintId: 'sample', resourceId: 'probeSkill', input: 'ACTUAL_PROBE_INPUT' })
  assert.deepEqual(evidence.outcome, { ok: true, kind: 'succeeded', detail: 'CONFIGURED_PROBE' })
  assert.equal(host.calls[0].input, 'ACTUAL_PROBE_INPUT')
  assert.equal(host.calls[0].file, 'WHOLE_SKILL_TREE')
  assert.ok(host.calls[0].injections.some(text => text.includes('SKILL_CONTENT')))
  assert.equal(JSON.stringify(evidence).includes(h.root), false)
  await assert.rejects(h.service.hostProbe({ blueprintId: 'sample', resourceId: 'missing', input: '' }), safeError('blueprint/host-probe-invalid', h.root))
})

test('configured roots: admission-bound Skill drift fails closed, package remains frozen, old Attempt digest immutable', async t => {
  const host = hostRegistry(call => {
    call.packageText = readFileSync(join(call.options.meta.cwd, 'lib', 'agent.md'), 'utf8')
    call.skillFile = readFileSync(join(call.options.meta.cwd, '.blueprint-skills', '0', 'helpers', 'data.txt'), 'utf8')
    call.finish({ kind: 'completed' }, 'OUTPUT_' + host.calls.length)
  })
  const h = await fixture(t, { host })
  mkdirSync(join(h.rootDir, 'lib'))
  writeFileSync(join(h.rootDir, 'lib', 'agent.md'), 'FROZEN_AGENT_A')
  const shared = join(h.root, 'shared')
  const skill = join(shared, 'demo')
  mkdirSync(join(skill, 'helpers'), { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), 'SKILL_A')
  writeFileSync(join(skill, 'helpers', 'data.txt'), 'HELPER_A')
  h.config.skillRoots = [{ rootId: 'user-skills', rootPath: shared }]
  const graph = {
    nodes: [
      { id: 'first', kind: 'agentTask', agentRef: 'agent', skillRefs: ['skill'] },
      { id: 'review', kind: 'humanDecision' },
      { id: 'second', kind: 'agentTask', agentRef: 'agent', skillRefs: ['skill'] },
      { id: 'unused', kind: 'output' }
    ],
    edges: [
      { kind: 'control', from: 'first', to: 'review' },
      { kind: 'control', from: 'review@approve', to: 'second' },
      { kind: 'control', from: 'review@reject', to: 'unused' }
    ]
  }
  writeFileSync(
    join(h.rootDir, 'blueprint.json'),
    JSON.stringify(
      doc({
        resources: {
          agent: { kind: 'agent', path: 'lib/agent.md' },
          skill: { kind: 'skill', source: { kind: 'shared', rootId: 'user-skills', path: 'demo' } }
        },
        graph,
        presentation: { nodes: {} }
      })
    )
  )
  const document = await h.service.loadDefinition({ blueprintId: 'sample' })
  const admitted = await h.service.startRun({
    blueprintId: 'sample',
    expectedRevision: document.documentRevision,
    inputJson: '"ACTUAL_INPUT"',
    requestId: 'skill-update'
  })
  await drain(h.service)
  assert.equal((await h.service.inspectRun({ runId: admitted.runId })).state, 'waiting_input')
  const handle = [...h.service.runtimes.values()][0]
  const before = await handle.store.get(admitted.runId)
  const first = structuredClone(before.attempts.find(a => a.nodeId === 'first'))
  writeFileSync(join(skill, 'SKILL.md'), 'SKILL_B')
  writeFileSync(join(skill, 'helpers', 'data.txt'), 'HELPER_B')
  assert.equal(
    (await h.service.loadDefinition({ blueprintId: 'sample' })).semanticRevision,
    document.semanticRevision,
    'shared Skill bytes do not version the document'
  )
  writeFileSync(join(h.rootDir, 'lib', 'agent.md'), 'NEW_PACKAGE_B')
  assert.notEqual((await h.service.loadDefinition({ blueprintId: 'sample' })).semanticRevision, document.semanticRevision)
  await h.service.decide({ runId: admitted.runId, decisionId: 'approve-once', action: 'approve' })
  await drain(h.service)
  const after = await handle.store.get(admitted.runId)
  assert.equal(after.state, 'failed')
  assert.equal(host.calls.length, 1, 'TARGET: a changed shared binding must block the later Attempt before dispatch')
  assert.deepEqual(
    host.calls.map(c => c.packageText),
    ['FROZEN_AGENT_A']
  )
  assert.deepEqual(
    host.calls.map(c => c.skillFile),
    ['HELPER_A']
  )
  assert.deepEqual(
    host.calls.map(c => c.input),
    ['ACTUAL_INPUT']
  )
  assert.deepEqual(
    after.attempts.find(a => a.nodeId === 'first'),
    first
  )
  const second = after.attempts.find(a => a.nodeId === 'second')
  assert.equal(second.result.outcome.kind, 'binding-drift')
  assert.notEqual(second.intent.resourceDigests.skill, first.intent.resourceDigests.skill)
  assert.equal(second.intent.resourceDigests.$package, first.intent.resourceDigests.$package)
  assert.ok(Object.values(second.intent.resourceDigests).every(v => /^[a-f0-9]{64}$/.test(v)))
  const snapshot = await h.service.inspectRun({ runId: admitted.runId })
  assert.equal(resultCodec('inspectRun').safeParse(snapshot).success, true)
  assert.equal(snapshot.attempts.find(a => a.nodeId === 'second').resultKind, 'binding-drift')
  assert.equal((await h.service.decide({ runId: admitted.runId, decisionId: 'approve-once', action: 'approve' })).applied, false)
  await assert.rejects(h.service.decide({ runId: admitted.runId, decisionId: 'approve-once', action: 'reject' }), { code: 'blueprint/decision-invalid' })
  assert.deepEqual(await h.service.cancelRun({ runId: admitted.runId }), { runId: admitted.runId, state: 'failed' })
  assert.deepEqual(await handle.store.get(admitted.runId), after)
})
