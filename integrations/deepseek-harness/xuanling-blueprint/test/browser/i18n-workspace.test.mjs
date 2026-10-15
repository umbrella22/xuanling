// Main-authored boundary red/green tests. These use the production bootstrap,
// workspace and editor; no new module import or external fixture can cause red.
import assert from 'node:assert/strict'
import test from 'node:test'
import { inject } from '../../src/client/index.ts'
import { BlueprintWorkspace } from '../../src/client/workspace.ts'

const definition = {
  schemaVersion: 1,
  id: 'language-fixture',
  name: '用户定义 / user title',
  resources: {},
  graph: { nodes: [{ id: 'n-in', kind: 'input', outputs: { '用户.port': 'string' } }], edges: [] }
}
function host() {
  const document = {
    blueprintId: definition.id,
    definitionJson: JSON.stringify(definition),
    documentRevision: 'doc-1',
    semanticRevision: 'sem-1',
    layoutRevision: 'layout-1'
  }
  return {
    listDefinitions: async () => ({
      definitions: [{ blueprintId: definition.id, name: definition.name, documentRevision: 'doc-1', semanticRevision: 'sem-1' }]
    }),
    loadDefinition: async () => document
  }
}

test('C-01 bootstrap declares the native locale service dependency', () => {
  assert.ok(inject.includes('locale'), 'BLUEPRINT_NATIVE_LOCALE_DEPENDENCY_REQUIRED')
})

test('C-02 workspace stores a stable notice descriptor instead of localized UI sentences', () => {
  const workspace = new BlueprintWorkspace(host())
  assert.equal(typeof workspace.notice?.key, 'string', 'WORKSPACE_NOTICE_MUST_HAVE_STABLE_KEY')
  assert.equal(workspace.notice.key, 'status.loading')
})

test('C-06 old Run overlays are gated by definition semantics, not merely matching node IDs', async () => {
  const workspace = new BlueprintWorkspace(host())
  await workspace.initialize()
  await workspace.load(definition.id)
  workspace.runId = 'old-run'
  workspace.model.applySnapshot({
    runId: 'old-run',
    state: 'succeeded',
    seq: 1,
    definitionRevision: 'sem-1',
    attempts: [{ nodeId: 'n-in', state: 'succeeded', attempt: 1 }],
    logTail: []
  })
  assert.equal(workspace.runOverlayEligible, true, 'MATCHING_RUN_MAY_PROJECT_ON_UNCHANGED_GRAPH')
  workspace.editor.moveNode('n-in', 120, 180)
  assert.equal(workspace.runOverlayEligible, true, 'LAYOUT_CHANGE_IS_NOT_EXECUTION_CHANGE')
  workspace.editor.updateNode('n-in', { outputs: { '用户.port': 'number' } })
  assert.equal(workspace.runOverlayEligible, false, 'OLD_ATTEMPT_MUST_NOT_PROJECT_ON_EDITED_SEMANTICS')
  assert.equal(workspace.model.view.runId, 'old-run', 'RUN_DETAILS_REMAIN_AUTHORITATIVE')
})

test('C-02 awkward valid identities and user text roundtrip without locale-derived names', async () => {
  const workspace = new BlueprintWorkspace(host())
  await workspace.initialize()
  await workspace.load(definition.id)
  assert.equal(workspace.definition.name, definition.name)
  assert.deepEqual(workspace.definition.graph, definition.graph)
  assert.equal(Object.hasOwn(workspace.definition.graph.nodes[0], 'name'), false)
})
