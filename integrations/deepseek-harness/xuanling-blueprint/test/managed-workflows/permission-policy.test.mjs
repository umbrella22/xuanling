import assert from 'node:assert/strict'
import test from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { definition } from '../feedback-fixtures.mjs'
import { workflowHost, toolResponse, textResponse } from './public-host-fixture.mjs'

const save = h => h.service.saveDefinition({ blueprintId: 'feedback', definitionJson: JSON.stringify(definition()), expectedRevision: null })
async function modelTool(h, name, args, review) {
  let result
  const off = h.ctx.on('tools/result', (exec, value) => {
    if (exec.name === name) result = value
  })
  h.adapter.script.push(toolResponse(name, args), ...(review === undefined ? [] : [textResponse(JSON.stringify(review))]), textResponse('finished'))
  h.caller.followup(createUserMessage({ content: [{ type: 'text', text: 'execute the requested workflow operation' }], source: { kind: 'user' } }))
  await h.caller.whenIdle()
  off()
  assert.ok(result, 'the actual Agent must dispatch the tool')
  return result
}

test('Full access applies and reverts without human approval under the real never policy', async t => {
  const h = await workflowHost(t, { preset: 'danger-full-access' })
  const first = await save(h)
  const result = await h.dispatch('workflow_apply', {
    workflowId: 'feedback',
    definition: { ...definition(), name: 'updated' },
    expectedRevision: first.documentRevision
  })
  assert.equal(result.isError, false, 'Full access must authorize through its preset rather than requesting a never-policy approval')
  assert.equal(h.approvals.length, 0)
  const next = await h.service.loadDefinition({ blueprintId: 'feedback' })
  assert.equal(JSON.parse(next.definitionJson).name, 'updated')
  assert.equal(
    (await h.dispatch('workflow_revert', { workflowId: 'feedback', revision: first.documentRevision, expectedRevision: next.documentRevision })).isError,
    false
  )
  assert.equal(h.approvals.length, 0)
})

for (const name of ['blueprint_start', 'workflow_run'])
  test(`${name}: review rejection creates no Run`, async t => {
    const h = await workflowHost(t, { approval: 'rejected' })
    const doc = await save(h)
    const result = await modelTool(h, name, { blueprintId: 'feedback', expectedRevision: doc.documentRevision, input: { value: 'request' } })
    assert.equal(result.isError, true, `Run admission requires Host review before dispatch: ${JSON.stringify(result)}`)
    assert.equal(h.approvals.length, 1)
    assert.deepEqual((await h.service.queryRuns({ sessionId: h.caller.session.id })).runs, [])
  })

for (const name of ['blueprint_start', 'workflow_run'])
  test(`${name}: Full access admits once with no prompt, direct body cannot reuse that authority`, async t => {
    const h = await workflowHost(t, { preset: 'danger-full-access' })
    const doc = await save(h)
    const args = { blueprintId: 'feedback', expectedRevision: doc.documentRevision, input: { value: 'request' } }
    assert.equal((await h.dispatch(name, args)).isError, false)
    assert.equal(h.approvals.length, 0)
    await assert.rejects(h.ctx.tools.get(name).execute(args, { agent: h.caller, name, callId: 'direct', signal: new AbortController().signal }), {
      code: 'blueprint/approval-required'
    })
    assert.equal((await h.service.queryRuns({ sessionId: h.caller.session.id })).runs.length, 1)
  })

test('native never in a custom preset does not imply Full access', async t => {
  const h = await workflowHost(t)
  h.caller.session.append('approval/policy', { policy: 'never' })
  assert.equal(h.ctx.permissionPresets.current(h.caller.session), 'custom')
  const doc = await save(h)
  const result = await modelTool(h, 'workflow_apply', {
    workflowId: 'feedback',
    definition: { ...definition(), name: 'forbidden' },
    expectedRevision: doc.documentRevision
  })
  assert.equal(result.isError, true)
  assert.equal(h.approvals.length, 0)
  assert.equal((await h.service.loadDefinition({ blueprintId: 'feedback' })).documentRevision, doc.documentRevision)
})

test('native Auto denial with never remains final and creates no Run', async t => {
  const h = await workflowHost(t, { preset: 'auto', auto: true })
  h.caller.session.append('approval/policy', { policy: 'never' })
  assert.equal(h.ctx.permissionPresets.current(h.caller.session), 'auto')
  const doc = await save(h)
  const result = await modelTool(
    h,
    'blueprint_start',
    { blueprintId: 'feedback', expectedRevision: doc.documentRevision, input: { value: 'request' } },
    { risk: 'high', decision: 'deny' }
  )
  assert.equal(result.isError, true)
  assert.equal(result.error.info.code, 'AUTO_REVIEW_DENIED')
  assert.equal(h.approvals.length, 0)
  assert.deepEqual((await h.service.queryRuns({ sessionId: h.caller.session.id })).runs, [])
})

test('Full access still respects a downstream Host denial and a short-circuit cannot mint a grant', async t => {
  for (const shortCircuit of [false, true]) {
    const h = await workflowHost(t, { preset: 'danger-full-access' })
    const doc = await save(h)
    h.ctx.on('tools/pre-execute', async () => ({ kind: shortCircuit ? 'allow' : 'deny', reason: 'Host policy' }), { prepend: shortCircuit })
    const result = await h.dispatch('workflow_apply', {
      workflowId: 'feedback',
      definition: { ...definition(), name: 'forbidden' },
      expectedRevision: doc.documentRevision
    })
    assert.equal(result.isError, true)
    assert.equal((await h.service.loadDefinition({ blueprintId: 'feedback' })).documentRevision, doc.documentRevision)
  }
})

test('approval cancellation discards a late allowed-once and never admits the Run', async t => {
  const asked = Promise.withResolvers(),
    answer = Promise.withResolvers()
  const h = await workflowHost(t, {
    approval: () => {
      asked.resolve()
      return answer.promise
    }
  })
  const doc = await save(h)
  const running = modelTool(h, 'blueprint_start', { blueprintId: 'feedback', expectedRevision: doc.documentRevision, input: { value: 'request' } })
  await asked.promise
  h.caller.cancel({ kind: 'user' })
  answer.resolve('allowed-once')
  assert.equal((await running).isError, true)
  assert.deepEqual((await h.service.queryRuns({ sessionId: h.caller.session.id })).runs, [])
})

test('Auto uses the real reviewer allow without a second human approval', async t => {
  const h = await workflowHost(t, { preset: 'auto', auto: true, approval: 'rejected' })
  const doc = await save(h)
  h.adapter.script.push(
    toolResponse('workflow_apply', { workflowId: 'feedback', definition: { ...definition(), name: 'auto-reviewed' }, expectedRevision: doc.documentRevision }),
    textResponse('{"risk":"low","decision":"allow"}'),
    textResponse('finished')
  )
  h.caller.followup(createUserMessage({ content: [{ type: 'text', text: 'update the blueprint title' }], source: { kind: 'user' } }))
  await h.caller.whenIdle()
  assert.equal(h.adapter.requests.length, 3, 'actual Auto reviewer must run')
  assert.equal(h.approvals.length, 0, 'reviewer allow must not trigger duplicate manual approval')
  assert.equal(JSON.parse((await h.service.loadDefinition({ blueprintId: 'feedback' })).definitionJson).name, 'auto-reviewed')
})
