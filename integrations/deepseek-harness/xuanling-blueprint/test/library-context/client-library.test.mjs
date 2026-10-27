/**
 * T13 (W2 part, C-13): the production workspace controller keeps library
 * selection, catalog and writes on the same logical identity.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { BlueprintWorkspace } from '../../src/client/features/authoring/logic/workspace/workspace-controller.ts'
import { createPanelWorkspaceBinding } from '../../src/client/features/authoring/ui/panel/panel-workspace-binding.ts'

const definitionJson = (id, name = id) => JSON.stringify({ schemaVersion: 2, id, name, resources: {}, graph: { nodes: [], edges: [] } })

function storage() {
  const values = new Map()
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, value)
  }
}

function libraries() {
  return [
    {
      library: { kind: 'global' },
      title: 'Global',
      status: 'ready',
      diagnostics: [],
      assets: [{ blueprintId: 'bp-global', name: 'Global Plan', documentRevision: 'r1', semanticRevision: 's1', status: 'ready' }]
    },
    {
      library: { kind: 'workspace', workspaceId: 'ws-a' },
      title: 'Alpha Docs',
      status: 'ready',
      diagnostics: [],
      assets: [{ blueprintId: 'bp-alpha', name: 'Alpha Plan', documentRevision: 'r2', semanticRevision: 's2', status: 'ready' }]
    },
    { library: { kind: 'workspace', workspaceId: 'ws-empty' }, title: 'Empty', status: 'empty', diagnostics: [], assets: [] }
  ]
}

function fakeHost(calls, defaultLibrary = { kind: 'global' }) {
  return {
    listBlueprintLibraries: async () => {
      calls.push({ method: 'listBlueprintLibraries' })
      return { libraries: libraries(), defaultLibrary }
    },
    listDefinitions: async library => {
      calls.push({ method: 'listDefinitions', library })
      const summary = libraries().find(row => (library?.kind === 'global' ? row.library.kind === 'global' : row.library.workspaceId === library?.workspaceId))
      return {
        definitions: (summary?.assets ?? []).map(({ blueprintId, name, documentRevision, semanticRevision }) => ({
          blueprintId,
          name,
          documentRevision,
          semanticRevision
        }))
      }
    },
    listResources: async selection => {
      calls.push({ method: 'listResources', selection })
      return { resources: [] }
    },
    validate: async () => ({ ok: true, semanticRevision: 's' }),
    loadDefinition: async (blueprintId, library) => {
      calls.push({ method: 'loadDefinition', blueprintId, library })
      return { blueprintId, definitionJson: definitionJson(blueprintId), documentRevision: 'r', semanticRevision: 's', layoutRevision: 'l' }
    },
    createDefinition: async (requestId, json, library) => {
      calls.push({ method: 'createDefinition', requestId, library })
      const created = { ...JSON.parse(json), id: 'bp-created' }
      return {
        blueprintId: 'bp-created',
        definitionJson: JSON.stringify(created),
        documentRevision: 'r3',
        semanticRevision: 's3',
        layoutRevision: 'l3'
      }
    },
    saveDefinition: async (blueprintId, json, revision, library) => {
      calls.push({ method: 'saveDefinition', blueprintId, library })
      return { blueprintId, definitionJson: json, documentRevision: 'r4', semanticRevision: 's4', layoutRevision: 'l4' }
    },
    deleteDefinition: async (blueprintId, revision, requestId, library) => {
      calls.push({ method: 'deleteDefinition', blueprintId, library })
      return { blueprintId, deleted: true }
    },
    exportDefinition: async (blueprintId, library) => {
      calls.push({ method: 'exportDefinition', blueprintId, library })
      return { blueprintId, closureDigest: 'c', files: 1, archiveSha256: 'a', archiveBase64: 'AA==', requiredBindings: [] }
    },
    importDefinition: async (blueprintId, archiveBase64, library) => {
      calls.push({ method: 'importDefinition', blueprintId, library })
      return { blueprintId, filesWritten: 1, closureDigest: 'c' }
    },
    preflightRun: async (blueprintId, revision, input, selection) => {
      calls.push({ method: 'preflightRun', blueprintId, selection })
      return {
        blueprintId,
        documentRevision: revision,
        semanticRevision: 's4',
        canStart: true,
        checks: []
      }
    },
    startRun: async (blueprintId, revision, input, requestId, selection) => {
      calls.push({ method: 'startRun', blueprintId, selection })
      return { runId: 'run-1', semanticRevision: 's4', state: 'queued', replayed: false }
    },
    inspectRun: async () => null,
    cancelRun: async runId => ({ runId, state: 'cancelled' }),
    decide: async (runId, decisionId, _action) => ({ runId, decisionId, state: 'running', applied: true })
  }
}

test('T13: initialize projects every library and selects the Host default', async t => {
  const calls = []
  const workspace = new BlueprintWorkspace(fakeHost(calls), storage())
  t.after(() => workspace.dispose())
  await workspace.initialize('Untitled')

  assert.equal(workspace.libraryState, 'current')
  assert.equal(workspace.libraries.length, 3)
  assert.deepEqual(workspace.library, { kind: 'global' })
  assert.deepEqual(
    workspace.catalog.map(item => item.blueprintId),
    ['bp-global']
  )
  assert.equal(workspace.libraryState, 'current')
  assert.equal(workspace.isNewDraft, false)

  // Resources were read with the selected library, never process cwd.
  const resourceCall = calls.find(call => call.method === 'listResources')
  assert.deepEqual(resourceCall.selection, { library: { kind: 'global' } })
})

test('T13: selecting a workspace library switches catalog and keeps writes on that library', async t => {
  const calls = []
  const workspace = new BlueprintWorkspace(fakeHost(calls), storage())
  t.after(() => workspace.dispose())
  await workspace.initialize('Untitled')

  workspaceLeaseSelect(workspace, { kind: 'workspace', workspaceId: 'ws-a' })
  assert.deepEqual(workspace.library, { kind: 'workspace', workspaceId: 'ws-a' })
  assert.deepEqual(
    workspace.catalog.map(item => item.blueprintId),
    ['bp-alpha']
  )
  assert.equal(workspace.isNewDraft, true)

  await workspace.save()
  const create = calls.find(call => call.method === 'createDefinition')
  assert.ok(create, 'new draft must create through the Host')
  assert.deepEqual(create.library, { kind: 'workspace', workspaceId: 'ws-a' })

  // A selected project is the execution target for preflight/start.
  await workspace.checkRun()
  const preflight = calls.find(call => call.method === 'preflightRun')
  assert.deepEqual(preflight.selection, { library: { kind: 'workspace', workspaceId: 'ws-a' }, workspaceId: 'ws-a' })

  workspace.dispatch({ type: 'load', blueprintId: 'bp-alpha' })
  await Promise.resolve()
  const load = calls.find(call => call.method === 'loadDefinition')
  assert.deepEqual(load.library, { kind: 'workspace', workspaceId: 'ws-a' })
})

test('T13: an older library response cannot overwrite a newer selection', async t => {
  const calls = []
  const host = fakeHost(calls)
  let release
  const gate = new Promise(resolve => {
    release = resolve
  })
  const original = host.listBlueprintLibraries
  host.listBlueprintLibraries = async () => {
    const value = await original()
    await gate
    return value
  }
  const workspace = new BlueprintWorkspace(host, storage())
  t.after(() => workspace.dispose())
  const pending = workspace.initialize('Untitled')
  // Switch while the first cascade read is still in flight.
  workspaceLeaseSelect(workspace, { kind: 'workspace', workspaceId: 'ws-empty' })
  release()
  await pending
  assert.deepEqual(workspace.library, { kind: 'workspace', workspaceId: 'ws-empty' })
})

function workspaceLeaseSelect(workspace, library) {
  workspace.dispatch({ type: 'select-library', library })
}

test('T13: the first cascade projection adopts the Host default workspace', async t => {
  const calls = []
  const workspace = new BlueprintWorkspace(fakeHost(calls, { kind: 'workspace', workspaceId: 'ws-a' }), storage())
  t.after(() => workspace.dispose())
  await workspace.initialize('Untitled')
  assert.deepEqual(workspace.library, { kind: 'workspace', workspaceId: 'ws-a' })
  assert.deepEqual(
    workspace.catalog.map(item => item.blueprintId),
    ['bp-alpha']
  )
  assert.equal(workspace.libraryState, 'current')
})

test('T13: the production panel binding admits library selection and refresh, but rejects stale views', async t => {
  const calls = []
  const workspace = new BlueprintWorkspace(fakeHost(calls, { kind: 'workspace', workspaceId: 'ws-a' }), storage())
  const binding = createPanelWorkspaceBinding(workspace)
  const release = binding.acquire()
  t.after(release)
  await workspace.initialize('Untitled')
  const before = binding.capture(workspace.getSnapshot().binding)
  before.dispatch({ type: 'select-library', library: { kind: 'global' } })
  assert.deepEqual(workspace.library, { kind: 'global' })
  const reads = calls.filter(call => call.method === 'listBlueprintLibraries').length
  await binding.capture(workspace.getSnapshot().binding).dispatch({ type: 'refresh-libraries' })
  assert.equal(calls.filter(call => call.method === 'listBlueprintLibraries').length, reads + 1)
  before.dispatch({ type: 'select-library', library: { kind: 'workspace', workspaceId: 'ws-a' } })
  assert.deepEqual(workspace.library, { kind: 'global' }, 'old panel lease must not change the current library')
})
