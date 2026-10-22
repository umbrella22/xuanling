import assert from 'node:assert/strict'
import test from 'node:test'
import { BlueprintWorkspace } from '../../src/client/features/authoring/logic/workspace/workspace-controller.ts'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const definition = { schemaVersion: 2, id: 'target', name: 'Target', resources: {}, graph: { nodes: [], edges: [] } }
const document = {
  blueprintId: 'target',
  documentRevision: 'doc',
  semanticRevision: 'semantic',
  layoutRevision: 'layout',
  definitionJson: JSON.stringify(definition)
}
const run = { runId: 'run-one', state: 'running', seq: 0, definitionRevision: 'semantic', attempts: [], logTail: [] }
const catalog = [{ blueprintId: 'target', name: 'Target', documentRevision: 'doc', semanticRevision: 'semantic' }]
function fixture(host) {
  const writes = []
  const value = new BlueprintWorkspace(host, { getItem: () => null, setItem: (...args) => writes.push(args) })
  return { value, writes }
}

test('dispose supplies the permanent lifecycle boundary', () => {
  const { value } = fixture()
  assert.equal(typeof value.dispose, 'function', 'WORKSPACE_DISPOSE_BOUNDARY_MISSING')
})
test('bound subscribe supports unsubscribe/remount while dispose permanently detaches all observations', () => {
  const { value, writes } = fixture()
  const subscribe = value.subscribe
  let count = 0
  const off = subscribe(() => count++)
  value.inputJson = '1'
  off()
  value.inputJson = '2'
  const offAgain = subscribe(() => count++)
  value.newDraft('active')
  assert.equal(count, 2)
  const editor = value.editor
  const before = value.getSnapshot()
  const writesBefore = writes.length
  value.dispose()
  value.dispose()
  offAgain()
  subscribe(() => count++)()
  editor.setSelection(['late'])
  value.model.applySnapshot(run)
  value.inputJson = '3'
  value.runId = 'late'
  value.newDraft('late')
  assert.equal(value.getSnapshot(), before)
  assert.equal(writes.length, writesBefore)
  assert.equal(count, 2)
})
test('disposed commands reject with a client typed code and perform skips its callback', async () => {
  let calls = 0
  const { value } = fixture(
    new Proxy(
      {},
      {
        get: () => () => {
          calls++
          throw new Error('unexpected Host call')
        }
      }
    )
  )
  value.dispose()
  for (const action of [
    () => value.initialize(),
    () => value.refreshResources(),
    () => value.load('target'),
    () => value.save(),
    () => value.deleteCurrent(),
    () => value.exportArchive(),
    () => value.importArchive('target', '', 'target'),
    () => value.checkRun(),
    () => value.run(),
    () => value.inspect(),
    () => value.cancel(),
    () => value.decide('approve')
  ]) {
    await assert.rejects(action, error => error.code === 'blueprint/workspace-disposed')
  }
  await value.perform(async () => {
    calls++
  })
  assert.equal(calls, 0)
})
test('pending perform settles without publishing or changing the disposed snapshot', async () => {
  const { value } = fixture()
  const pending = deferred()
  const work = value.perform(() => pending.promise)
  const before = value.getSnapshot()
  assert.equal(before.busy, true)
  value.dispose()
  pending.reject(new Error('late private failure'))
  await work
  assert.equal(value.getSnapshot(), before)
  assert.equal(value.busy, true)
})
test('pending resource initialization cannot continue to Host catalog after disposal', async () => {
  const pending = deferred()
  let listCalls = 0
  const { value } = fixture({
    listResources: () => pending.promise,
    listDefinitions: async () => {
      listCalls++
      return { definitions: [] }
    }
  })
  const work = value.initialize()
  const before = value.getSnapshot()
  value.dispose()
  pending.resolve({ resources: [] })
  await work
  assert.equal(listCalls, 0)
  assert.equal(value.getSnapshot(), before)
})
test('pending load and inspect responses cannot install or adopt facts after disposal', async () => {
  const load = deferred()
  const inspect = deferred()
  const { value } = fixture({ loadDefinition: () => load.promise, inspectRun: () => inspect.promise })
  value.catalog = catalog
  const work = value.load('target')
  const before = value.getSnapshot()
  value.dispose()
  load.resolve(document)
  await work
  assert.equal(value.getSnapshot(), before)
  assert.equal(value.document, null)
  const other = fixture({ inspectRun: () => inspect.promise }).value
  other.blueprintId = 'target'
  other.runId = 'run-one'
  const read = other.inspect()
  const published = other.getSnapshot()
  other.dispose()
  inspect.resolve(run)
  await read
  assert.equal(other.model.view, null, 'late resync must not adopt into mutable model either')
  assert.equal(other.getSnapshot(), published)
})
test('new draft and load publish coherent synchronous transitions and flush loading before await', async () => {
  const pending = deferred()
  const { value } = fixture({ loadDefinition: () => pending.promise })
  value.runId = 'old-run'
  const seen = []
  value.subscribe(() => seen.push(value.getSnapshot()))
  value.newDraft('new')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].definition.id, seen[0].blueprintId)
  assert.equal(seen[0].run.runId, null)
  value.catalog = catalog
  const work = value.load('target')
  assert.equal(seen.length, 2)
  assert.equal(seen[1].blueprintId, null)
  assert.equal(seen[1].definition, null)
  assert.equal(seen[1].notice.key, 'status.loadingDocument')
  pending.resolve(document)
  await work
  assert.equal(seen.length, 3)
  assert.equal(seen[2].definition.id, 'target')
  assert.equal(seen[2].notice.key, 'status.loaded')
})

async function loaded(hostExtra = {}) {
  const host = {
    loadDefinition: async () => document,
    saveDefinition: async () => document,
    preflightRun: async () => ({ blueprintId: 'target', documentRevision: 'doc', semanticRevision: 'semantic', canStart: true, checks: [] }),
    ...hostExtra
  }
  const result = fixture(host)
  result.value.catalog = catalog
  await result.value.load('target')
  return result
}

test('pending save/check do not continue preflight or mutate document after disposal', async () => {
  for (const operation of ['save', 'checkRun']) {
    const pending = deferred()
    let checks = 0
    const { value } = await loaded({
      saveDefinition: () => pending.promise,
      preflightRun: async () => {
        checks++
        throw new Error('must not dispatch')
      }
    })
    const work = value[operation]()
    const before = value.getSnapshot()
    value.dispose()
    pending.resolve({ ...document, documentRevision: 'late-doc' })
    await assert.rejects(work, /Document changed while saving/)
    assert.equal(checks, 0)
    assert.equal(value.document.documentRevision, 'doc')
    assert.equal(value.getSnapshot(), before)
  }
})
test('pending preflight cannot admit a run after disposal', async () => {
  const pending = deferred()
  const started = deferred()
  let starts = 0
  const { value } = await loaded({
    preflightRun: () => {
      started.resolve()
      return pending.promise
    },
    startRun: async () => {
      starts++
      throw new Error('must not dispatch')
    }
  })
  const work = value.run()
  await started.promise
  const before = value.getSnapshot()
  value.dispose()
  pending.resolve({ blueprintId: 'target', documentRevision: 'doc', semanticRevision: 'semantic', canStart: true, checks: [] })
  await assert.rejects(work, error => error.code === 'blueprint/preflight-stale')
  assert.equal(starts, 0)
  assert.equal(value.getSnapshot(), before)
})
test('already dispatched admission preserves captured recent-run binding without inspect or cancellation', async () => {
  const pending = deferred()
  const started = deferred()
  let inspections = 0,
    cancellations = 0
  const { value, writes } = await loaded({
    startRun: () => {
      started.resolve()
      return pending.promise
    },
    inspectRun: async () => {
      inspections++
      return run
    },
    cancelRun: async () => {
      cancellations++
    }
  })
  const work = value.run()
  await started.promise
  const before = value.getSnapshot()
  value.dispose()
  pending.resolve({ runId: 'admitted', state: 'queued', replayed: false })
  await work
  assert.equal(value.getSnapshot(), before)
  assert.equal(inspections, 0)
  assert.equal(cancellations, 0)
  assert.ok(writes.some(([key, json]) => key.endsWith('recent-run:target') && JSON.parse(json).runId === 'admitted'))
})

test('pending export-save and import discovery do not dispatch subsequent Host commands', async () => {
  const save = deferred()
  let exports = 0
  const { value } = await loaded({
    saveDefinition: () => save.promise,
    exportDefinition: async () => {
      exports++
      return {}
    }
  })
  value.editor.setSelection(['selection'])
  value.editor.renameDefinition('Changed')
  const work = value.exportArchive()
  value.dispose()
  save.resolve(document)
  await assert.rejects(work)
  assert.equal(exports, 0)
  const discovery = deferred()
  let imports = 0
  const second = fixture({
    listDefinitions: () => discovery.promise,
    importDefinition: async () => {
      imports++
      return {}
    }
  }).value
  const importing = second.importArchive('target', 'archive', 'target')
  second.dispose()
  discovery.resolve({ definitions: [{ ...catalog[0], documentRevision: null }] })
  await assert.rejects(importing, error => error.code === 'blueprint/document-stale')
  assert.equal(imports, 0)
})
test('pending cancel and decision do not follow with inspect after disposal', async () => {
  for (const action of ['cancel', 'decide']) {
    const pending = deferred()
    let inspections = 0
    const { value } = await loaded({
      cancelRun: () => pending.promise,
      decide: () => pending.promise,
      inspectRun: async () => {
        inspections++
        return run
      }
    })
    value.runId = 'run-one'
    value.model.applySnapshot({ ...run, attempts: [{ nodeId: 'waiting', attempt: 1, state: 'waiting_input' }] })
    const work = action === 'decide' ? value.decide('approve') : value.cancel()
    const before = value.getSnapshot()
    value.dispose()
    pending.resolve({})
    await work
    assert.equal(inspections, 0)
    assert.equal(value.getSnapshot(), before)
  }
})

test('delete settlement emits only the final deleted notice with a coherent new draft', async () => {
  const { value } = await loaded({ deleteDefinition: async () => ({ blueprintId: 'target', deleted: true }) })
  const seen = []
  value.subscribe(() => seen.push(value.getSnapshot()))
  await value.deleteCurrent('replacement')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].notice.key, 'status.deleted')
  assert.equal(seen[0].definition.id, seen[0].blueprintId)
  assert.equal(seen[0].definition.name, 'replacement')
})
