import assert from 'node:assert/strict'
import test from 'node:test'
import { BlueprintWorkspace } from '../../src/client/features/authoring/logic/workspace/workspace-controller.ts'
import { WorkspaceIntentError } from '../../src/client/features/authoring/logic/workspace/workspace-intents.ts'

const definition = { schemaVersion: 1, id: 'target', name: 'Target', resources: {}, graph: { nodes: [], edges: [] } }
const document = {
  blueprintId: 'target',
  documentRevision: 'doc',
  semanticRevision: 'semantic',
  layoutRevision: 'layout',
  definitionJson: JSON.stringify(definition)
}
const run = { runId: 'run-one', state: 'running', seq: 0, definitionRevision: 'semantic', attempts: [], logTail: [] }

test('Workspace exposes typed dispatch boundary', () => {
  assert.equal(typeof new BlueprintWorkspace(undefined).dispatch, 'function', 'WORKSPACE_INTENT_DISPATCH_MISSING')
})
test('invalid data rejects before Host, storage, editor or snapshot effects', () => {
  let calls = 0
  const workspace = new BlueprintWorkspace(new Proxy({}, { get: () => () => calls++ }), { getItem: () => null, setItem: () => calls++ })
  const before = workspace.getSnapshot()
  const hidden = Object.defineProperty({ type: 'save' }, 'callback', { value: () => calls++ })
  const accessor = Object.defineProperty({}, 'type', {
    get: () => {
      calls++
      return 'save'
    }
  })
  for (const intent of [
    null,
    [],
    'save',
    {},
    { type: 'unknown' },
    { type: 'load' },
    { type: 'set-input', inputJson: 1 },
    { type: 'bind-run' },
    { type: 'decide', action: 'other' },
    { type: 'import', blueprintId: 'a', archiveBase64: '' },
    { type: 'save', callback: () => calls++ },
    { type: 'save', event: { target: {} } },
    hidden,
    accessor
  ]) {
    assert.throws(() => workspace.dispatch(intent), WorkspaceIntentError)
    assert.equal(workspace.getSnapshot(), before)
  }
  assert.equal(calls, 0)
})
test('sync intents preserve exact strings and isolate Workspace instances', () => {
  const first = new BlueprintWorkspace(undefined)
  const second = new BlueprintWorkspace(undefined)
  const dispatch = first.dispatch
  assert.equal(dispatch({ type: 'set-input', inputJson: ' \n{}  ' }), undefined)
  assert.equal(first.inputJson, ' \n{}  ')
  first.dispatch({ type: 'new-draft', name: '  exact name  ' })
  assert.equal(first.editor.exportDefinition().name, '  exact name  ')
  first.dispatch({ type: 'bind-run', runId: ' run ' })
  assert.equal(first.runId, ' run ')
  first.dispatch({ type: 'bind-run', runId: null })
  assert.equal(first.runId, null)
  assert.equal(second.inputJson, '{}')
  assert.equal(second.blueprintId, null)
})
test('async intents preserve each existing method Promise and argument contract', async () => {
  const workspace = new BlueprintWorkspace(undefined)
  const cases = [
    ['initialize', { draftName: ' draft ' }, 'initialize', [' draft ']],
    ['refresh-resources', {}, 'refreshResources', []],
    ['load', { blueprintId: ' target ' }, 'load', [' target ']],
    ['save', {}, 'save', []],
    ['delete', { draftName: '' }, 'deleteCurrent', ['']],
    ['export', {}, 'exportArchive', []],
    ['import', { blueprintId: 'a', archiveBase64: ' raw ', confirmedId: 'a' }, 'importArchive', ['a', ' raw ', 'a']],
    ['check-run', {}, 'checkRun', []],
    ['run', {}, 'run', []],
    ['inspect', {}, 'inspect', []],
    ['cancel', {}, 'cancel', []],
    ['decide', { action: 'reject' }, 'decide', ['reject']]
  ]
  for (const [type, payload, method, expected] of cases) {
    const result = { type }
    const promise = Promise.resolve(result)
    workspace[method] = (...args) => {
      assert.deepEqual(args, expected)
      return promise
    }
    assert.equal(workspace.dispatch({ type, ...payload }), promise)
    assert.equal(await promise, result)
  }
})
test('real save, check and export forward authoritative Host values', async () => {
  const archive = { blueprintId: 'target', archiveBase64: 'archive' }
  const report = { blueprintId: 'target', documentRevision: 'doc', semanticRevision: 'semantic', canStart: true, checks: [] }
  const workspace = new BlueprintWorkspace({
    loadDefinition: async () => document,
    saveDefinition: async () => document,
    preflightRun: async () => report,
    exportDefinition: async () => archive
  })
  workspace.catalog = [{ blueprintId: 'target', name: 'Target', documentRevision: 'doc', semanticRevision: 'semantic' }]
  await workspace.dispatch({ type: 'load', blueprintId: 'target' })
  assert.equal(await workspace.dispatch({ type: 'save' }), document)
  assert.deepEqual(await workspace.dispatch({ type: 'check-run' }), report)
  assert.equal(await workspace.dispatch({ type: 'export' }), archive)
})
test('perform owns busy admission while direct background dispatch stays available', async () => {
  const workspace = new BlueprintWorkspace(undefined)
  let finish
  let inspected = 0
  workspace.inspect = async () => {
    inspected++
  }
  const pending = workspace.perform(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  await workspace.perform(() => workspace.dispatch({ type: 'inspect' }))
  assert.equal(inspected, 0)
  await workspace.dispatch({ type: 'inspect' })
  assert.equal(inspected, 1)
  finish()
  await pending
  assert.equal(workspace.busy, false)
})
test('local validation inside perform preserves connectivity and yields a typed notice', async () => {
  const workspace = new BlueprintWorkspace(undefined)
  workspace.runId = run.runId
  workspace.model.applySnapshot(run)
  const connection = workspace.model.connectionState
  assert.equal(connection, 'connected')
  await workspace.perform(() => workspace.dispatch({ type: 'decide', action: 'invalid' }))
  assert.equal(workspace.notice.params.code, 'blueprint/workspace-intent-invalid')
  assert.equal(workspace.model.connectionState, connection)
})
test('disposed dispatch blocks sync and async commands before any effect', () => {
  const workspace = new BlueprintWorkspace(undefined)
  workspace.dispose()
  const before = workspace.getSnapshot()
  let called = false
  workspace.save = async () => {
    called = true
  }
  for (const intent of [{ type: 'set-input', inputJson: 'late' }, { type: 'new-draft' }, { type: 'save' }]) {
    assert.throws(
      () => workspace.dispatch(intent),
      error => error.code === 'blueprint/workspace-disposed'
    )
  }
  assert.equal(workspace.getSnapshot(), before)
  assert.equal(called, false)
})
