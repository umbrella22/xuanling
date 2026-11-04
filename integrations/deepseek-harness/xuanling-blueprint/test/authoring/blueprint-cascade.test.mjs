import test from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_LIBRARY_PREFIX, blueprintCascadeProjection } from '../../src/client/features/authoring/ui/panel/blueprint-cascade.ts'

const t = key =>
  ({
    'library.chooseId': 'Choose',
    'library.global': 'Global',
    'library.scope': 'Workspace',
    'library.empty': 'No blueprints',
    'document.newDraft': 'New draft'
  })[key] ?? key
const library = (libraryRef, title, assets) => ({ library: libraryRef, title, status: assets.length ? 'ready' : 'empty', assets, diagnostics: [] })
const asset = (blueprintId, name, status = 'ready') => ({ blueprintId, name, documentRevision: 'rev', semanticRevision: 'sem', status })
const workspace = id => ({ kind: 'workspace', workspaceId: id })
const current = workspace('alpha')

const base = { t, library: current, libraries: [], catalog: [], blueprintId: null, definitionName: undefined, isNewDraft: false }

test('flattens a catalog-only host without groups and resolves by id', () => {
  const projection = blueprintCascadeProjection({
    ...base,
    catalog: [
      { blueprintId: 'flow', name: 'Flow' },
      { blueprintId: 'flow-b', name: 'Flow B' }
    ],
    blueprintId: 'flow'
  })
  assert.deepEqual(
    projection.options.map(option => option.value),
    ['', 'flow', 'flow-b']
  )
  assert.equal(
    projection.options.some(option => option.group !== undefined),
    false
  )
  assert.equal(projection.value, 'flow')
  assert.equal(projection.selectedName, 'Flow')
  assert.deepEqual(projection.resolve('flow-b'), { library: current, blueprintId: 'flow-b' })
})

test('orders the current workspace first and groups every library option', () => {
  const beta = workspace('beta')
  const projection = blueprintCascadeProjection({
    ...base,
    libraries: [
      library({ kind: 'global' }, 'Global', []),
      library(beta, 'Beta', [asset('beta-flow', 'Beta Flow')]),
      library(current, 'Alpha', [asset('flow', 'Flow'), asset('flow-b', 'Flow B')])
    ],
    blueprintId: 'flow'
  })
  assert.deepEqual(
    projection.options.map(option => option.value),
    ['', 'flow', 'flow-b', `${EMPTY_LIBRARY_PREFIX}global`, 'beta-flow']
  )
  assert.deepEqual(
    projection.options.filter(option => option.value !== '').map(option => option.group),
    ['Alpha', 'Alpha', 'Global', 'Beta']
  )
  assert.equal(projection.value, 'flow')
})

test('cross-library selection resolves to the owning library and empty libraries expose a switch entry', () => {
  const beta = workspace('beta')
  const projection = blueprintCascadeProjection({
    ...base,
    libraries: [library(current, 'Alpha', [asset('flow', 'Flow')]), library(beta, 'Beta', [asset('beta-flow', 'Beta Flow')])],
    blueprintId: 'flow'
  })
  assert.deepEqual(projection.resolve('beta-flow'), { library: beta, blueprintId: 'beta-flow' })
  const switchOnly = projection.resolve(`${EMPTY_LIBRARY_PREFIX}workspace:gamma`)
  assert.equal(switchOnly, null)
})

test('draft documents stay selectable under the current workspace group', () => {
  const projection = blueprintCascadeProjection({
    ...base,
    libraries: [library(current, 'Alpha', [asset('flow', 'Flow')])],
    blueprintId: 'draft-alpha',
    definitionName: 'Draft plan',
    isNewDraft: true
  })
  const draft = projection.options.find(option => option.value === 'draft-alpha')
  assert.equal(draft?.group, 'Alpha')
  assert.equal(draft?.label, 'Draft plan')
  assert.deepEqual(projection.resolve('draft-alpha'), { library: current, blueprintId: 'draft-alpha' })
})
