/** W4 supplemental C-08/C-04: saved-service Agent text and typed diagnostics
 * are distinct representations. Reuse frozen real Context/ToolRuntime/scope,
 * public Session and JSON RunStore; the factory never decodes followup text.
 * Controlled completion is source evidence only, not real-provider evidence. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { definition, drain, harness, records, sha256 } from './agent-fixtures.mjs'

const cases = [
  { id: 'whitespace-string', type: 'string', input: ' \t\r\n  ' },
  { id: 'quoted-string', type: 'string', input: 'before "quoted" and \'single\' after' },
  { id: 'backslash-string', type: 'string', input: 'C:\\中文\\file\\n \\\\ literal' },
  { id: 'multiline-string', type: 'string', input: 'first\nsecond\r\nthird\tend' },
  { id: 'unicode-string', type: 'string', input: '  中文输入：原文，不翻译、不裁剪。  ' },
  { id: 'json-object-shaped-string', type: 'string', input: '{ "中文": "值", "nested": [true, null, 1] }' },
  { id: 'json-array-shaped-string', type: 'string', input: '[1, "中文", false, null]' },
  { id: 'json-primitive-shaped-string', type: 'string', input: 'false' },
  { id: 'empty-string', type: 'string', input: '' },
  { id: 'object', type: 'object', input: { z: '中文\n"quote"\\path', a: [true, null, 2] } },
  { id: 'array', type: 'array', input: ['中文', { value: '\\literal\nline' }, false, null, 3] },
  { id: 'boolean-true', type: 'boolean', input: true },
  { id: 'boolean-false', type: 'boolean', input: false },
  { id: 'number', type: 'number', input: -12.5 },
  { id: 'zero', type: 'number', input: 0 },
  { id: 'null', type: 'null', input: null }
]

for (const { id, type, input } of cases) {
  test(`C-08/C-04 saved-service ${id}: exact Agent input and canonical typed diagnostics`, async t => {
    const h = await harness(t, {
      onTurn: async call => {
        // Read the real durable intent before the public Agent turn completes.
        call.beforeResult = (await records(h))[0]
        call.finish()
      }
    })
    assert.ok(h.ctx instanceof Context, 'fixture: use installed public Context')
    assert.ok(h.nativeTools instanceof ToolRuntime, 'fixture: parent has real installed Tools')
    const doc = await h.save(definition())
    const canonical = JSON.stringify(input)
    // Admission formatting must survive in inputRef, not enter typed diagnostics
    // or become whitespace added to the Agent's logical text.
    const inputJson = `\n  ${JSON.stringify(input, null, 2)}\t `
    const requestId = `input-representation-${id}`
    const preflight = await h.service.preflightRun({
      blueprintId: doc.blueprintId,
      expectedRevision: doc.documentRevision,
      inputJson
    })
    assert.equal(preflight.canStart, true, 'fixture: real Host preflight admits the saved Agent definition')
    assert.equal(preflight.documentRevision, doc.documentRevision)
    assert.equal(preflight.semanticRevision, doc.semanticRevision)
    assert.equal(h.host.calls.length, 0, 'C-08: preflight must not compose an Agent')

    const args = { blueprintId: doc.blueprintId, expectedRevision: doc.documentRevision, inputJson, requestId }
    const admitted = await h.service.startRun(args)
    await drain(h)
    const record = (await records(h)).find(run => run.runId === admitted.runId)
    assert.ok(record, 'C-08: the public admitted Run is durable')
    assert.equal(record.state, 'succeeded', 'control: an actual completed turn, not just factory calls')
    assert.equal(record.inputRef, inputJson, 'C-08: admission retains the exact original JSON representation')
    assert.equal(record.log[0].detail.requestId, requestId, 'C-08: admission retains command identity')
    assert.equal(h.host.calls.length, 1)
    const call = h.host.calls[0]
    assert.equal(call.published, true, 'fixture: setup committed before publication')
    assert.equal(scopeOf(call.agent.ctx), call.agent, 'fixture: real Agent scope owns restrict/guard')
    assert.equal(call.disposed, true, 'control: completed Agent became quiescent and scope was disposed')
    const users = call.session.snapshotEvents().filter(event => event.type === 'user/message')
    assert.equal(users.length, 1, 'C-08: inspect the actual single followup, not an injected prompt')
    assert.equal(users[0].data.content.length, 1)
    assert.equal(users[0].data.content[0].type, 'text')
    const actual = users[0].data.content[0].text

    const expectedInputDiagnostic = { type, bytes: Buffer.byteLength(canonical), sha256: sha256(canonical) }
    const before = call.beforeResult.attempts.find(attempt => attempt.nodeId === 'work')
    assert.equal(before.result, undefined, 'C-04: observation is the durable pre-effect intent')
    assert.equal(before.diagnostics.status, 'available')
    assert.equal(before.diagnostics.acceptance.code, 'pending')
    assert.deepEqual(before.diagnostics.input, expectedInputDiagnostic, 'C-04: pending diagnostics hash canonical typed JSON, not Agent text')
    const attempt = record.attempts.find(item => item.nodeId === 'work')
    assert.equal(attempt.state, 'succeeded')
    assert.equal(attempt.result.ok, true)
    assert.equal(attempt.diagnostics.status, 'available')
    assert.equal(attempt.diagnostics.acceptance.code, 'not-required')
    assert.deepEqual(attempt.diagnostics.input, expectedInputDiagnostic, 'C-04: final diagnostics preserve the typed value, bytes and digest')
    const inspected = await h.service.inspectRun({ runId: admitted.runId })
    assert.deepEqual(inspected.attempts.find(item => item.nodeId === 'work').diagnostics, attempt.diagnostics)

    const replay = await h.service.startRun(args)
    assert.equal(replay.runId, admitted.runId, 'C-08: identical request/payload replays the canonical Run')
    assert.equal(replay.replayed, true)
    assert.equal(h.host.calls.length, 1, 'C-08: replay does not dispatch another Agent')
    assert.deepEqual(
      (await records(h)).find(run => run.runId === admitted.runId),
      record
    )

    // No fixture decode/trim: this is the actual public Session followup text.
    const expected = type === 'string' ? input : canonical
    assert.equal(actual, expected, 'C-08: strings must reach Agent verbatim; only non-strings are JSON encoded')
    assert.deepEqual(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8'), 'C-08: followup preserves exact UTF-8 bytes')
  })
}
