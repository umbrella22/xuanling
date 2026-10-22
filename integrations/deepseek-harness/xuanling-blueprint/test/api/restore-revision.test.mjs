import assert from 'node:assert/strict'
import test from 'node:test'
import { definition, fixture } from '../feedback-fixtures.mjs'

test('canvas restore applies a semantic revision with CAS and keeps both revisions in history', async t => {
  const f = await fixture(t)
  const blueprint = f.ctx.blueprint
  const first = await blueprint.saveDefinition({ blueprintId: 'feedback', definitionJson: JSON.stringify(definition()), expectedRevision: null })
  const changed = {
    ...definition(),
    name: 'changed',
    graph: { nodes: [...definition().graph.nodes, { id: 'second', kind: 'input', outputs: { value: 'string' } }], edges: [] }
  }
  const second = await blueprint.saveDefinition({ blueprintId: 'feedback', definitionJson: JSON.stringify(changed), expectedRevision: first.documentRevision })

  await assert.rejects(
    blueprint.restoreDefinitionRevision({ blueprintId: 'feedback', revision: first.documentRevision, expectedRevision: first.documentRevision }),
    { code: 'blueprint/revision-conflict' },
    'a stale canvas cannot restore over a newer document'
  )

  const restored = await blueprint.restoreDefinitionRevision({
    blueprintId: 'feedback',
    revision: first.documentRevision,
    expectedRevision: second.documentRevision
  })
  assert.equal(JSON.parse(restored.definitionJson).name, 'feedback')
  assert.equal(JSON.parse(restored.definitionJson).graph.nodes.length, 1)
  const loaded = await blueprint.loadDefinition({ blueprintId: 'feedback' })
  assert.equal(loaded.documentRevision, restored.documentRevision)

  const history = await blueprint.workflowRevisions({ workflowId: 'feedback' })
  assert.equal(restored.documentRevision, first.documentRevision, 'revisions are content-addressed: restoring yields the original revision id')
  assert.deepEqual(
    history.revisions.map(entry => entry.revision).sort(),
    [first.documentRevision, second.documentRevision].sort(),
    'both revisions stay in history; the later one remains restorable'
  )

  await assert.rejects(blueprint.restoreDefinitionRevision({ blueprintId: 'feedback', revision: '', expectedRevision: restored.documentRevision }), {
    code: 'gateway/bad-request'
  })
})

test('canvas restore reports an unknown revision with a typed error and no write', async t => {
  const f = await fixture(t)
  const blueprint = f.ctx.blueprint
  const saved = await blueprint.saveDefinition({ blueprintId: 'feedback', definitionJson: JSON.stringify(definition()), expectedRevision: null })

  await assert.rejects(
    blueprint.restoreDefinitionRevision({
      blueprintId: 'feedback',
      revision: 'revision-that-does-not-exist',
      expectedRevision: saved.documentRevision
    }),
    { code: 'blueprint/revision-not-found' }
  )
  const loaded = await blueprint.loadDefinition({ blueprintId: 'feedback' })
  assert.equal(loaded.documentRevision, saved.documentRevision, 'a rejected restore leaves the current document untouched')
})
