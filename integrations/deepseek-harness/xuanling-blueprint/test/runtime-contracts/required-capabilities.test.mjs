/** BP-01: required capabilities are enforced at admission, not inferred from
 * prompt text. Zero business tools blocks; a bound toolset passes the gate but
 * its real coverage stays explicitly unverified. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { harness, definition, agentNode, bindingResources, runArgs } from './agent-fixtures.mjs'

const preflight = (h, doc) =>
  h.service.preflightRun({
    blueprintId: doc.blueprintId,
    expectedRevision: doc.documentRevision,
    inputJson: JSON.stringify({ task: 'read the repository' })
  })

test('BP-01 preflight: a declared capability with no business tool blocks admission', async t => {
  const h = await harness(t)
  const doc = await h.save(definition([agentNode({ requiredCapabilities: ['repository-read'] })]))
  const report = await preflight(h, doc)
  assert.equal(report.canStart, false)
  assert.ok(
    report.checks.some(check => check.code === 'required-capability-unbound' && check.status === 'block' && check.nodeId === 'work'),
    'a task that declares repository-read but resolves zero tools must block'
  )
  await assert.rejects(h.service.startRun(runArgs(doc)), error => error.code === 'blueprint/preflight-blocked')
  assert.equal(h.host.calls.length, 0, 'blocked admission publishes no Agent')
  await h.close()
})

test('BP-01 preflight: a bound toolset satisfies the gate while coverage stays unverified', async t => {
  const h = await harness(t, { config: { toolBindings: { reader: { tools: ['read_allowed'] } } } })
  const doc = await h.save(definition([agentNode({ toolsetRefs: ['readset'], requiredCapabilities: ['repository-read', 'command-exec'] })], bindingResources))
  const report = await preflight(h, doc)
  assert.equal(report.canStart, true)
  assert.ok(report.checks.some(check => check.code === 'required-capability-ready' && check.status === 'pass' && check.nodeId === 'work'))
  assert.ok(
    report.checks.some(check => check.code === 'capability-coverage-unverified' && check.status === 'warning' && check.nodeId === 'work'),
    'binding existence is not proof the toolset can read a repository'
  )
  await h.close()
})

test('BP-01 preflight: text-only tasks stay runnable without the field', async t => {
  const h = await harness(t)
  const doc = await h.save(definition([agentNode()]))
  const report = await preflight(h, doc)
  assert.equal(report.canStart, true)
  assert.equal(
    report.checks.some(check => check.code.startsWith('required-capability')),
    false
  )
  await h.close()
})
