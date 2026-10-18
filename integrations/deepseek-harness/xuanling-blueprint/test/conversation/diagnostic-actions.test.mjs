import assert from 'node:assert/strict'
import test from 'node:test'
import { preflightActionKey } from '../../src/client/shared/diagnostics/diagnostics-model.ts'

test('preflight action mapping turns stable check codes into bounded next actions', () => {
  assert.equal(preflightActionKey('input-missing'), 'diagnostics.action.input')
  assert.equal(preflightActionKey('host-resource-unavailable'), 'diagnostics.action.resource')
  assert.equal(preflightActionKey('model-route-declared'), 'diagnostics.action.model')
  assert.equal(preflightActionKey('tool-binding-unavailable'), 'diagnostics.action.tools')
  assert.equal(preflightActionKey('output-schema-unavailable'), 'diagnostics.action.schema')
  assert.equal(preflightActionKey('host-approval-unverified'), 'diagnostics.action.inspect')
  assert.equal(preflightActionKey('future-host-code'), 'diagnostics.action.retry')
})
