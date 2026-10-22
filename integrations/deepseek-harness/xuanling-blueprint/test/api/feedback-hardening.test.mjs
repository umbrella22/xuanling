import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { definition, fixture } from '../feedback-fixtures.mjs'
import { Context } from '@deepseek-ai/cordis'
import { BlueprintService } from '../../src/index.ts'

test('empty config uses the Host workspace, persists drafts, and reports an unavailable Host', async t => {
  const f = await fixture(t, { emptyConfig: true })
  const saved = await f.ctx.blueprint.createDefinition({ requestId: 'empty-config', definitionJson: JSON.stringify(definition()) })
  assert.ok(existsSync(join(f.root, 'workspace', '.xuanling', 'workflows', saved.blueprintId, 'blueprint.json')))
  assert.equal(existsSync(join(f.root, 'profile', '.xuanling')), false)
  assert.equal((await f.ctx.blueprint.listDefinitions()).definitions.length, 1)
  const reopened = new Context()
  reopened.provide('workspaceController', { initializeDefault: async () => ({ workspace: { path: join(f.root, 'workspace') } }) })
  try {
    await reopened.plugin(BlueprintService, {})
    assert.equal((await reopened.blueprint.loadDefinition({ blueprintId: saved.blueprintId })).documentRevision, saved.documentRevision)
  } finally {
    await reopened.fiber.dispose()
  }
  const unavailable = await fixture(t, { emptyConfig: true, workspace: false })
  await assert.rejects(() => unavailable.ctx.blueprint.listDefinitions(), { code: 'blueprint/capability-unavailable' })
})

test('one registered Host workspace is usable; ambiguous workspace selection requires configuration', async t => {
  const f = await fixture(t, { emptyConfig: true, workspace: false })
  f.ctx.provide('workspaceRegistry', { list: () => [{ path: join(f.root, 'workspace') }] })
  assert.ok((await f.ctx.blueprint.createDefinition({ requestId: 'registered', definitionJson: JSON.stringify(definition()) })).blueprintId)
  const ambiguous = await fixture(t, { emptyConfig: true, workspace: false })
  ambiguous.ctx.provide('workspaceRegistry', { list: () => [{ path: join(ambiguous.root, 'one') }, { path: join(ambiguous.root, 'two') }] })
  await assert.rejects(() => ambiguous.ctx.blueprint.listDefinitions(), { code: 'blueprint/capability-unavailable' })
})

test('public apply rejects model approval and missing CAS; origin cannot confer authority', async t => {
  const f = await fixture(t)
  const first = await f.ctx.blueprint.saveDefinition({ blueprintId: 'feedback', definitionJson: JSON.stringify(definition()), expectedRevision: null })
  const args = { workflowId: 'feedback', definitionJson: JSON.stringify({ ...definition(), name: 'changed' }), expectedRevision: first.documentRevision }
  const before = readFileSync(join(f.workflow, 'blueprint.json'))
  await assert.rejects(() => f.ctx.blueprint.workflowApply({ ...args, approveSemantic: true }), { code: 'gateway/bad-request' })
  const { expectedRevision: _expectedRevision, ...missingBase } = args
  await assert.rejects(() => f.ctx.blueprint.workflowApply(missingBase), { code: 'gateway/bad-request' })
  assert.equal((await f.ctx.blueprint.workflowApply({ ...args, origin: 'canvas' })).status, 'approval-required')
  assert.deepEqual(readFileSync(join(f.workflow, 'blueprint.json')), before)
})

test('real ToolRuntime approval allow, rejection, cancellation and missing service control apply/revert', async t => {
  for (const outcome of ['allowed-once', 'rejected', 'cancelled', 'unavailable', undefined]) {
    let approvals = 0
    const f = await fixture(t, {
      approval:
        outcome &&
        (async () => {
          approvals++
          return outcome
        })
    })
    const first = await f.ctx.blueprint.saveDefinition({ blueprintId: 'feedback', definitionJson: JSON.stringify(definition()), expectedRevision: null })
    const before = readFileSync(join(f.workflow, 'blueprint.json'))
    const result = await f.dispatch('workflow_apply', {
      workflowId: 'feedback',
      definition: { ...definition(), name: 'changed' },
      expectedRevision: first.documentRevision
    })
    assert.equal(Boolean(result.isError), outcome !== 'allowed-once', JSON.stringify(result))
    assert.equal(approvals, outcome ? 1 : 0)
    if (outcome !== 'allowed-once') {
      const deniedRevert = await f.dispatch('workflow_revert', {
        workflowId: 'feedback',
        revision: first.documentRevision,
        expectedRevision: first.documentRevision
      })
      assert.equal(Boolean(deniedRevert.isError), true, JSON.stringify(deniedRevert))
      assert.equal(approvals, outcome ? 2 : 0)
      assert.deepEqual(readFileSync(join(f.workflow, 'blueprint.json')), before)
    } else {
      const changed = await f.ctx.blueprint.loadDefinition({ blueprintId: 'feedback' })
      assert.equal(JSON.parse(changed.definitionJson).name, 'changed')
      const reverted = await f.dispatch('workflow_revert', {
        workflowId: 'feedback',
        revision: first.documentRevision,
        expectedRevision: changed.documentRevision
      })
      assert.equal(Boolean(reverted.isError), false, JSON.stringify(reverted))
      assert.equal(JSON.parse((await f.ctx.blueprint.loadDefinition({ blueprintId: 'feedback' })).definitionJson).name, 'feedback')
      assert.equal(approvals, 2)
    }
  }
})

test('resource validation rejects missing closure without modifying the canonical definition', async t => {
  const f = await fixture(t)
  await f.ctx.blueprint.saveDefinition({ blueprintId: 'feedback', definitionJson: JSON.stringify(definition()), expectedRevision: null })
  const before = readFileSync(join(f.workflow, 'blueprint.json'))
  const result = await f.ctx.blueprint.workflowValidate({
    workflowId: 'feedback',
    definitionJson: JSON.stringify({ ...definition(), resources: { missing: { kind: 'script', path: 'lib/missing.mjs' } } })
  })
  assert.equal(result.ok, false)
  assert.equal(result.issues[0].code, 'package-resource-missing')
  assert.deepEqual(readFileSync(join(f.workflow, 'blueprint.json')), before)
})

test('resource validation reports unreadable bytes with a safe typed issue', async t => {
  const f = await fixture(t)
  await f.ctx.blueprint.saveDefinition({ blueprintId: 'feedback', definitionJson: JSON.stringify(definition()), expectedRevision: null })
  fs.mkdirSync(join(f.workflow, 'lib'))
  const resource = join(f.workflow, 'lib/value.txt')
  fs.writeFileSync(resource, 'value')
  const read = fs.readFileSync
  fs.readFileSync = (path, ...args) => {
    if (String(path) === resource) throw Object.assign(new Error('private machine path must not escape'), { code: 'EACCES' })
    return read(path, ...args)
  }
  syncBuiltinESMExports()
  try {
    const result = await f.ctx.blueprint.workflowValidate({ workflowId: 'feedback', definitionJson: JSON.stringify(definition()) })
    assert.equal(result.ok, false)
    assert.equal(result.issues[0].code, 'package-resource-unreadable')
    assert.equal(JSON.stringify(result).includes('private machine'), false)
  } finally {
    fs.readFileSync = read
    syncBuiltinESMExports()
  }
})

test('direct tool body and an overriding pre-execute handler cannot mint workflow approval', async t => {
  const f = await fixture(t, { preExecute: async () => ({ kind: 'allow' }) })
  const first = await f.ctx.blueprint.saveDefinition({ blueprintId: 'feedback', definitionJson: JSON.stringify(definition()), expectedRevision: null })
  const args = { workflowId: 'feedback', definition: { ...definition(), name: 'unauthorized' }, expectedRevision: first.documentRevision }
  const before = readFileSync(join(f.workflow, 'blueprint.json'))
  const result = await f.dispatch('workflow_apply', args)
  assert.equal(Boolean(result.isError), true, JSON.stringify(result))
  await assert.rejects(() => f.tools.get('workflow_apply').execute(args, { name: 'workflow_apply', callId: 'direct', signal: new AbortController().signal }))
  assert.deepEqual(readFileSync(join(f.workflow, 'blueprint.json')), before)
})

test('approved stale apply is rejected after a concurrent canvas save', async t => {
  const f = await fixture(t, { approval: async () => 'allowed-once' })
  const first = await f.ctx.blueprint.saveDefinition({ blueprintId: 'feedback', definitionJson: JSON.stringify(definition()), expectedRevision: null })
  const second = await f.ctx.blueprint.saveDefinition({
    blueprintId: 'feedback',
    definitionJson: JSON.stringify({ ...definition(), name: 'canvas edit' }),
    expectedRevision: first.documentRevision
  })
  const result = await f.dispatch('workflow_apply', {
    workflowId: 'feedback',
    definition: { ...definition(), name: 'stale edit' },
    expectedRevision: first.documentRevision
  })
  assert.equal(Boolean(result.isError), true, JSON.stringify(result))
  assert.equal((await f.ctx.blueprint.loadDefinition({ blueprintId: 'feedback' })).documentRevision, second.documentRevision)
})
