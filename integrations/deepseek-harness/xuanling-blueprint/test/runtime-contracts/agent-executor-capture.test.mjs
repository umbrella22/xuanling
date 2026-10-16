/** B-exclusive additions to the frozen W1 oracle: own-property model capture,
 * schema-only structured permission, and exact source/license provenance.
 * Uses the existing W1 public scope/factory fixture, not a new A helper. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { hasPnpmImporterDependency, readPnpmLock } from '../package/pnpm-lock.mjs'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { captureAgentModelSelection } from '../../src/host/agent-executor.ts'
import { harness, directSpec, contentTool, executeTool } from './agent-fixtures.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const selection = { provider: 'selected-provider', model: 'selected-model', reasoningEffort: 'adapter-custom-effort' }

test('C-04 explicit own-property modelSelection undefined means no Host reread or factory model override', async t => {
  const h = await harness(t)
  let reads = 0
  t.mock.method(h.ctx.get('agentDefaultModel'), 'currentSelection', () => {
    reads++
    return selection
  })
  const result = await h.executor().execute(directSpec(h, { modelSelection: undefined }))
  assert.equal(result.outcome.ok, true)
  assert.equal(reads, 0, 'C-04: explicit undefined is a captured fact, not permission to read Host again')
  assert.equal(Object.hasOwn(h.host.calls[0].options, 'agentOptions'), false, 'C-04: no invented model override')
})

test('C-04 direct execution without modelSelection captures Host exactly once as detached factory options', async t => {
  const h = await harness(t)
  let reads = 0
  const mutable = { ...selection }
  t.mock.method(h.ctx.get('agentDefaultModel'), 'currentSelection', () => {
    reads++
    return mutable
  })
  const job = h.executor().execute(directSpec(h))
  mutable.model = 'changed-after-capture'
  const result = await job
  assert.equal(result.outcome.ok, true)
  assert.equal(reads, 1, 'C-04: direct fallback uses the same single-capture contract')
  assert.deepEqual(h.host.calls[0].options.agentOptions, selection)
  assert.notEqual(h.host.calls[0].options.agentOptions, mutable)
})

test('C-04 driver capture is detached and authoritative even when Host changes before Agent creation', async t => {
  const h = await harness(t)
  let reads = 0
  const mutable = { ...selection }
  t.mock.method(h.ctx.get('agentDefaultModel'), 'currentSelection', () => {
    reads++
    return mutable
  })
  const captured = captureAgentModelSelection(h.ctx)
  assert.deepEqual(captured, selection)
  assert.notEqual(captured, mutable)
  mutable.model = 'new-host-default'
  const result = await h.executor().execute(directSpec(h, { modelSelection: captured }))
  assert.equal(result.outcome.ok, true)
  assert.equal(reads, 1, 'C-04: executor must not perform a second capture after driver intent')
  assert.deepEqual(h.host.calls[0].options.agentOptions, selection)
  assert.notEqual(h.host.calls[0].options.agentOptions, captured)
})

test('C-02/C-03 reserved structured_output permission cannot be granted by a business allowlist without schema', async t => {
  let bodies = 0
  const h = await harness(t, {
    onTurn: async call => {
      call.agent.ctx.tools.register(
        contentTool('structured_output', () => {
          bodies++
        })
      )
      call.result = await executeTool(call, 'structured_output', { raw: 'ARG_SECRET_SENTINEL' })
      call.finish()
    }
  })
  const result = await h.executor().execute(directSpec(h, { effectiveToolNames: ['structured_output', 'run_code'] }))
  assert.equal(result.outcome.ok, true, 'control: tool denial does not manufacture an Agent failure')
  assert.equal(h.host.calls[0].result.isError, true, 'C-02: only an attached schema grants the structured exception')
  assert.equal(bodies, 0)
  assert.deepEqual(result.toolDenials, [{ toolName: 'structured_output', code: 'tool-not-permitted' }])
  assert.equal(JSON.stringify(result.toolDenials).includes('ARG_SECRET_SENTINEL'), false)
  assert.equal(result.acceptance.code, 'not-required')
})

test('C-03 source provenance: compat body is unchanged; full pinned MIT notice and installed tools peer are distributed', () => {
  const source = readFileSync(new URL('../../src/host/dsh-structured-compat.ts', import.meta.url))
  const headerEnd = source.indexOf(Buffer.from('*/\n')) + 3
  assert.ok(headerEnd > 3, 'C-03: attribution is a single leading comment')
  assert.equal(
    hash(source.subarray(headerEnd)),
    '0c911d97ef20b7f18509d7a3e49b0000da1d723aa6e77060161c1ff311596975',
    'C-03: compat changes may not silently replace the upstream capture protocol'
  )
  const notice = readFileSync(new URL('../../THIRD-PARTY-NOTICES.md', import.meta.url), 'utf8')
  assert.ok(notice.includes('5badb15009ae1756c3afe0ae0cef1faafc290ccc'))
  assert.ok(notice.includes('Copyright (c) 2026 DeepSeek'))
  const licenseOffset = notice.indexOf('MIT License\n')
  assert.ok(licenseOffset >= 0, 'C-03: the full license, not merely an MIT label, must be present')
  assert.equal(
    hash(Buffer.from(notice.slice(licenseOffset, notice.indexOf('\n\n\n## CodeMirror') + 1))),
    'ebb4f09972aee8608be255debaf78451a68e95c290f55c240dec2ecfa16ea6be'
  )
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  const lock = readPnpmLock(fileURLToPath(new URL('../../', import.meta.url)))
  assert.ok(pkg.files.includes('THIRD-PARTY-NOTICES.md'), 'C-03: packed candidate includes attribution/license')
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-tools'], '0.2.1-alpha.4')
  assert.equal(hasPnpmImporterDependency(lock, 'devDependencies', '@deepseek-ai/dsh-tools', '0.2.1-alpha.4'), true)
  assert.equal(
    Object.hasOwn(pkg.dependencies ?? {}, '@deepseek-ai/dsh-tools'),
    false,
    'C-03: the packed plugin relies on the host peer, not a private production tools runtime'
  )
  assert.equal(
    hasPnpmImporterDependency(lock, 'devDependencies', '@deepseek-ai/dsh-tools', pkg.devDependencies['@deepseek-ai/dsh-tools']),
    true,
    'C-03: the explicitly declared local test runtime is a development dependency'
  )
})
