import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { BlueprintWorkspace } from '../../src/client/features/authoring/logic/workspace/workspace-controller.ts'
const presenterUrl = new URL('../../src/client/features/authoring/presenters/workspace-presenter.ts', import.meta.url)
test('Workspace has the missing pure presentation boundary', () => {
  assert.ok(existsSync(presenterUrl), 'WORKSPACE_PRESENTER_BOUNDARY_MISSING')
  assert.match(readFileSync(presenterUrl, 'utf8'), /export function presentWorkspace\(/)
})
const present = async value => (await import(presenterUrl.href)).presentWorkspace(value.getSnapshot())

test('empty, draft and mutable Host capability facts project without changing button policy', async () => {
  const empty = new BlueprintWorkspace(undefined)
  assert.equal((await present(empty)).document.revisionStateKey, 'document.none')
  assert.equal((await present(empty)).capabilities.hostAvailable, false)
  const host = {}
  const value = new BlueprintWorkspace(host)
  value.newDraft('Draft')
  const before = await present(value)
  assert.equal(before.document.revisionStateKey, 'document.newDraft')
  assert.equal(before.document.deleteDisabled, false)
  assert.equal(before.capabilities.canExport, false)
  host.exportDefinition = async () => ({})
  value.inputJson = '1'
  assert.equal((await present(value)).capabilities.canExport, true)
  value.editor.renameDefinition('Changed')
  assert.equal((await present(value)).document.revisionStateKey, 'document.unsaved')
})

test('resource rows preserve metadata and portable identity while omitting references and raw configuration', async () => {
  const value = new BlueprintWorkspace(undefined)
  value.newDraft('Resources')
  value.editor.updateResource(
    'host-agent',
    { kind: 'agent', source: { kind: 'host', id: 'agent-one' }, bindingId: 'binding' },
    { title: 'Local title', description: 'Local description' }
  )
  value.editor.updateResource('shared', { kind: 'skill', source: { kind: 'shared', rootId: 'root', path: 'skill.md' } })
  value.editor.updateResource('packaged', { kind: 'mcp', source: { kind: 'package', path: 'mcp.json' } })
  value.resourceCatalog = [
    {
      id: 'agent-one',
      kind: 'agent',
      displayName: 'Host title',
      description: 'Host description',
      source: 'dsh',
      availability: 'available',
      provenance: 'builtin',
      rawConfig: { env: 'SECRET_SENTINEL', url: 'PRIVATE_URL' }
    }
  ]
  value.resourceCatalogState = 'current'
  value.inputJson = 'publish'
  const snapshot = value.getSnapshot()
  const original = JSON.stringify(snapshot)
  const projected = await present(value)
  const row = projected.resources.agent[0]
  assert.equal(row.displayName, 'Local title')
  assert.equal(row.description, 'Local description')
  assert.equal(row.configuration.bindingId, 'binding')
  assert.equal(row.metadata.titleSource, 'presentation')
  assert.equal(Object.hasOwn(row, 'ref'), false)
  assert.equal(JSON.stringify(projected).includes('SECRET_SENTINEL'), false)
  assert.equal(JSON.stringify(projected).includes('PRIVATE_URL'), false)
  assert.equal(projected.resources.skill[0].configuration.path, 'skill.md')
  assert.equal(projected.resources.mcp[0].configuration.path, 'mcp.json')
  assert.equal(JSON.stringify(snapshot), original)
  assert.deepEqual(await present(value), projected)
  for (const state of ['loading', 'unavailable']) {
    value.resourceCatalogState = state
    value.inputJson += ' '
    assert.equal((await present(value)).resources.agent[0].availability, 'unknown')
  }
})

const definition = { schemaVersion: 2, id: 'one', name: 'One', resources: {}, graph: { nodes: [], edges: [] } }
const document = {
  blueprintId: 'one',
  documentRevision: 'doc',
  semanticRevision: 'semantic',
  layoutRevision: 'layout',
  definitionJson: JSON.stringify(definition)
}
async function loaded(preflightRun) {
  const value = new BlueprintWorkspace({ loadDefinition: async () => document, saveDefinition: async () => document, preflightRun })
  value.catalog = [{ blueprintId: 'one', name: 'One', documentRevision: 'doc', semanticRevision: 'semantic' }]
  await value.load('one')
  return value
}

test('actual preflight validation failures remain typed diagnostics instead of empty success', async () => {
  const value = await loaded(async () => ({ privateRawBody: 'DO_NOT_DISPLAY' }))
  await assert.rejects(value.checkRun(), error => error.code === 'blueprint/dto-invalid')
  const projected = await present(value)
  assert.equal(projected.preflight.status, 'failed')
  assert.equal(projected.preflight.code, 'blueprint/dto-invalid')
  assert.equal(JSON.stringify(projected).includes('DO_NOT_DISPLAY'), false)
})
test('preflight state and warning counts survive stale input and malformed input uses typed notice', async () => {
  const value = await loaded(async () => ({
    blueprintId: 'one',
    documentRevision: 'doc',
    semanticRevision: 'semantic',
    canStart: true,
    checks: [{ code: 'warning-code', status: 'warning' }]
  }))
  await value.checkRun()
  assert.equal((await present(value)).preflight.status, 'current')
  assert.equal((await present(value)).preflight.warningCount, 1)
  value.inputJson = '{"changed":true}'
  assert.equal((await present(value)).preflight.status, 'stale')
  value.inputJson = '{RAW_PARSER_SECRET'
  await value.perform(() => value.checkRun())
  const result = await present(value)
  assert.equal(result.inputJson, '{RAW_PARSER_SECRET')
  assert.equal(result.notice.key, 'status.invalidRunInput')
  assert.equal(JSON.stringify(result.notice).includes('RAW_PARSER_SECRET'), false)
})
test('Run summary retains details when stale or overlay-ineligible and stays isolated between workspaces', async () => {
  const value = new BlueprintWorkspace(undefined)
  value.runId = 'run'
  value.model.applySnapshot({
    runId: 'run',
    state: 'running',
    seq: 0,
    definitionRevision: 'old',
    attempts: [{ nodeId: 'node', attempt: 1, state: 'running', outputJson: 'PRIVATE_OUTPUT' }],
    logTail: []
  })
  value.model.markDisconnected()
  const result = await present(value)
  assert.equal(result.run.overlayEligible, false)
  assert.equal(result.run.hasDetails, true)
  assert.equal(result.run.connectionState, 'stale')
  assert.equal(result.run.state, 'running')
  assert.equal(JSON.stringify(result).includes('PRIVATE_OUTPUT'), false)
  assert.equal((await present(new BlueprintWorkspace(undefined))).run.hasDetails, false)
})

test('pending loading projection does not expose the editor placeholder as a document', async () => {
  let resolve
  const pending = new Promise(accept => {
    resolve = accept
  })
  const value = new BlueprintWorkspace({ loadDefinition: () => pending })
  value.catalog = [{ blueprintId: 'one', name: 'One', documentRevision: 'doc', semanticRevision: 'semantic' }]
  const loading = value.load('one')
  const result = await present(value)
  assert.equal(result.document.id, null)
  assert.equal(result.document.name, '')
  assert.equal(result.notice.key, 'status.loadingDocument')
  resolve(document)
  await loading
  assert.equal((await present(value)).document.revisionStateKey, 'document.saved')
  assert.deepEqual((await present(value)).document.options, [{ id: 'one', name: 'One' }])
})
