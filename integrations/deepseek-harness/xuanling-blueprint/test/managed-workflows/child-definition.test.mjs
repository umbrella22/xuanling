import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeDefinition, validateDefinition } from '../../src/definition/index.ts'
import { workflowHost } from './public-host-fixture.mjs'
import { echoDefinition, parentDefinition, save, check } from './child-fixtures.mjs'

export const callDefinition = revision => ({
  schemaVersion: 2,
  id: 'parent',
  name: 'Parent',
  resources: {},
  graph: {
    nodes: [
      {
        id: 'child',
        kind: 'blueprintCall',
        blueprintRef: { blueprintId: 'child', documentRevision: revision },
        inputs: { value: 'string' },
        outputs: { value: 'string' }
      }
    ],
    edges: []
  }
})

test('call references are explicit revisions and never filenames or implicit latest', () => {
  for (const ref of [
    { blueprintId: '../outside', documentRevision: 'a'.repeat(64) },
    { blueprintId: 'child', documentRevision: 'latest' },
    { blueprintId: 'child' }
  ]) {
    const doc = callDefinition('a'.repeat(64))
    doc.graph.nodes[0].blueprintRef = ref
    assert.throws(() => decodeDefinition(JSON.stringify(doc)), { code: 'DEFINITION_INVALID' })
  }
})

for (const scenario of ['missing', 'interface', 'ambiguous', 'cycle']) {
  test(`preflight rejects ${scenario} child closure before creating a Run`, async t => {
    const h = await workflowHost(t, { preset: 'danger-full-access' })
    const child = echoDefinition()
    if (scenario === 'ambiguous') child.graph.nodes.push({ id: 'other', kind: 'input', outputs: { value: 'string' } })
    const saved = await save(h.service, child)
    const parent = parentDefinition(saved)
    if (scenario === 'missing') parent.graph.nodes[1].blueprintRef.documentRevision = 'a'.repeat(64)
    if (scenario === 'interface') parent.graph.nodes[1].outputs.extra = 'boolean'
    let doc
    if (scenario === 'cycle') {
      const intermediate = await save(h.service, parent)
      doc = await save(h.service, parentDefinition(intermediate, 'child'), saved.documentRevision)
    } else doc = await save(h.service, parent)
    const report = await check(h.service, doc)
    assert.equal(report.canStart, false)
    const code = {
      missing: 'blueprint-revision-unavailable',
      interface: 'blueprint-interface-mismatch',
      ambiguous: 'blueprint-interface-ambiguous',
      cycle: 'blueprint-reference-cycle'
    }[scenario]
    assert.ok(
      report.checks.some(item => item.code === code && item.status === 'block'),
      JSON.stringify(report)
    )
    await assert.rejects(
      h.service.startRun({ blueprintId: doc.blueprintId, expectedRevision: doc.documentRevision, inputJson: '{"value":"echo"}', requestId: scenario }),
      { code: 'blueprint/preflight-blocked' }
    )
    assert.equal((await (await h.service.configuredRuntime()).store.listRunIds()).length, 0)
  })
}

test('preflight reads the saved child revision after the current child interface changes', async t => {
  const h = await workflowHost(t, { preset: 'danger-full-access' })
  const child = await save(h.service, echoDefinition())
  const parent = await save(h.service, parentDefinition(child))
  const changed = echoDefinition()
  changed.graph.nodes[0].outputs.value = 'number'
  changed.graph.nodes[1].inputs.value = 'number'
  await save(h.service, changed, child.documentRevision)
  assert.equal((await check(h.service, parent)).canStart, true)
})

test('admission freezes the complete pinned dependency closure before dispatch', async t => {
  const h = await workflowHost(t, { preset: 'danger-full-access' })
  const leaf = await save(h.service, echoDefinition('leaf'))
  const child = await save(h.service, parentDefinition(leaf, 'child'))
  const parent = await save(h.service, parentDefinition(child))
  const dispatched = Promise.withResolvers()
  t.mock.method(h.service, 'driveRun', async (runtime, runId) => {
    dispatched.resolve(await runtime.store.get(runId))
  })
  await h.service.startRun({ blueprintId: parent.blueprintId, expectedRevision: parent.documentRevision, inputJson: '{"value":"echo"}', requestId: 'freeze' })
  const record = await dispatched.promise
  assert.deepEqual(record.composition?.map(item => item.blueprintId).sort(), ['child', 'leaf'])
  for (const saved of [leaf, child]) {
    const item = record.composition.find(item => item.blueprintId === saved.blueprintId)
    assert.equal(item.documentRevision, saved.documentRevision)
    assert.equal(item.definitionJson, saved.definitionJson)
    assert.ok(item.snapshotId)
    assert.ok(item.bindingDigests)
    assert.ok(item.bindingSelections)
  }
  assert.equal(record.bindingAdmission, 'captured')
})

test('saved child revision and its explicit interface are accepted by the public definition codec', () => {
  let decoded, failure
  try {
    decoded = decodeDefinition(JSON.stringify(callDefinition('a'.repeat(64))))
    validateDefinition(decoded)
  } catch (error) {
    failure = error
  }
  assert.equal(failure, undefined, 'blueprintCall must support an exact saved documentRevision')
  assert.equal(decoded.graph.nodes[0].blueprintRef.documentRevision, 'a'.repeat(64))
})
