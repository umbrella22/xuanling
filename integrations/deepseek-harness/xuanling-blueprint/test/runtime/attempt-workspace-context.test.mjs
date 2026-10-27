/**
 * T11a (C-11 pre-condition): an Attempt runs in the project checkout while its
 * frozen package and Skill trees stay under the runtime directory. This is the
 * observed cwd contract; write serialization is T11b in W6.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { harness, runSaved } from '../runtime-contracts/agent-fixtures.mjs'

test('T11a: ordinary node cwd is the project checkout; frozen bytes stay in the runtime', async t => {
  const h = await harness(t)
  const { record } = await runSaved(h)
  assert.equal(h.host.calls.length > 0, true, 'fixture must create one Agent')
  assert.equal(h.host.calls[0].options.meta.cwd, realpathSync(h.root), 'agent session cwd must be the project root')
  assert.equal(existsSync(join(h.root, 'blueprint.json')), false, 'package bytes must not be copied into the project')

  const attempt = record.attempts.find(item => item.state === 'succeeded')
  assert.ok(attempt)
  const resourceDir = join(h.runtimeRoot, 'attempts', record.runId, attempt.attemptId)
  assert.equal(existsSync(join(resourceDir, 'lib', 'agents', 'worker.md')), true, 'frozen package resources remain addressable at the isolated runtime path')
})
