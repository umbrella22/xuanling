/**
 * Main-reviewed W3 oracle representation correction; test-load boundary only.
 * Preload with --import. Do not edit the frozen W1 file or production codecs.
 * The complete original SHA and unique literal anchor are both mandatory:
 * source drift is a hard failure, never a reason to omit or catch a test.
 * Only this one introspection block changes; all 41 original tests still run.
 */
import { createHash } from 'node:crypto'
import { registerHooks } from 'node:module'

const targetUrl = new URL('./flow-ui-contracts.test.mjs', import.meta.url).href
const frozenSha256 = '4644e83dc065bb3d1153949641d5d77cf46ea0c880d667d7c5d93cceaf135a88'
const anchor = `  // Shape oracle does not invent the not-yet-frozen diagnostic field names.
  // Every diagnostic object has a strict whitelist, not an unbounded raw record.
  assert.ok(inner.shape, 'C-07: diagnostics must be a typed object, not arbitrary unknown')
  for (const key of ['rawPrompt', 'toolArguments', 'providerError', 'absoluteRoot', 'secret']) {
    assert.equal(Object.hasOwn(inner.shape, key), false, \`C-07 raw field \${key} forbidden\`)
  }`
const replacement = String.raw`  // W2 froze a strict status union, not a single object with .shape.
  // Check every real branch AND parse actual payloads through the public DTO.
  assert.ok(Array.isArray(inner.options), 'C-07: diagnostics must expose the frozen status union')
  assert.equal(inner.options.length, 2, 'C-07: available and unavailable are the two frozen branches')
  const diagnosticBaselines = {
    unavailable: { status: 'unavailable' },
    available: {
      status: 'available',
      input: { type: 'object', bytes: 2, sha256: '0'.repeat(64) },
      resourceDigests: {}, tools: { effectiveNames: [] }, acceptance: { code: 'not-required' },
    },
  }
  const diagnosticStatuses = []
  for (const branch of inner.options) {
    assert.ok(branch.shape, 'C-07: each diagnostics union branch must be a typed object')
    assert.ok(Object.hasOwn(branch.shape, 'status'), 'C-07: every diagnostics branch declares its status')
    const statuses = Object.keys(diagnosticBaselines).filter(status => branch.shape.status.safeParse(status).success)
    assert.equal(statuses.length, 1, 'C-07: each branch has exactly one frozen status')
    const status = statuses[0]
    diagnosticStatuses.push(status)
    const baseline = diagnosticBaselines[status]
    assert.equal(branch.safeParse(baseline).success, true, 'C-07: branch baseline must actually be valid')
    assert.equal(field.safeParse(baseline).success, true, 'C-07: public diagnostics DTO accepts the valid baseline')
    for (const key of ['rawPrompt', 'toolArguments', 'providerError', 'absoluteRoot', 'secret']) {
      assert.equal(Object.hasOwn(branch.shape, key), false, 'C-07 ' + status + ': raw field ' + key + ' forbidden in branch shape')
      const raw = { ...baseline, [key]: 'RAW_SECRET' }
      assert.equal(branch.safeParse(raw).success, false, 'C-07 ' + status + ': branch safeParse must reject ' + key)
      assert.equal(field.safeParse(raw).success, false, 'C-07 ' + status + ': public DTO safeParse must reject ' + key)
    }
    assert.equal(branch.safeParse({ ...baseline, unexpectedDiagnosticField: 'unknown' }).success, false,
      'C-07: branch objects must reject unknown fields, not silently strip or pass through')
    assert.equal(field.safeParse({ ...baseline, unexpectedDiagnosticField: 'unknown' }).success, false,
      'C-07: public diagnostics DTO must retain branch strictness')
    for (const invalidStatus of ['unknown', 'pending', '', null, 1]) {
      assert.equal(branch.safeParse({ ...baseline, status: invalidStatus }).success, false,
        'C-07: branch must reject invalid status')
      assert.equal(field.safeParse({ ...baseline, status: invalidStatus }).success, false,
        'C-07: public diagnostics DTO must reject invalid status')
    }
    const required = status === 'available' ? ['status', 'input', 'resourceDigests', 'tools', 'acceptance'] : ['status']
    for (const key of required) {
      const missing = { ...baseline }
      delete missing[key]
      assert.equal(branch.safeParse(missing).success, false, 'C-07 ' + status + ': branch requires ' + key)
      assert.equal(field.safeParse(missing).success, false, 'C-07 ' + status + ': public DTO requires ' + key)
    }
    if (status === 'available') {
      for (const [section, keys] of Object.entries({ input: ['type', 'bytes', 'sha256'], tools: ['effectiveNames'], acceptance: ['code'] })) {
        for (const key of keys) {
          const missing = { ...baseline, [section]: { ...baseline[section] } }
          delete missing[section][key]
          assert.equal(branch.safeParse(missing).success, false, 'C-07 available: branch requires ' + section + '.' + key)
          assert.equal(field.safeParse(missing).success, false, 'C-07 available: public DTO requires ' + section + '.' + key)
        }
      }
    }
  }
  assert.deepEqual(diagnosticStatuses.sort(), ['available', 'unavailable'], 'C-07: both frozen diagnostic branches were checked')`

registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context)
    if (url !== targetUrl) return loaded
    if (loaded.source === undefined || loaded.source === null) {
      throw new Error('DIAGNOSTICS_ORACLE_SOURCE_UNAVAILABLE')
    }
    const bytes = typeof loaded.source === 'string' ? Buffer.from(loaded.source, 'utf8') : Buffer.from(loaded.source)
    if (createHash('sha256').update(bytes).digest('hex') !== frozenSha256) {
      throw new Error('DIAGNOSTICS_ORACLE_FROZEN_SHA_MISMATCH')
    }
    const source = bytes.toString('utf8')
    const offset = source.indexOf(anchor)
    if (offset < 0 || source.indexOf(anchor, offset + anchor.length) !== -1) {
      throw new Error('DIAGNOSTICS_ORACLE_ANCHOR_NOT_UNIQUE')
    }
    return { ...loaded, source: source.slice(0, offset) + replacement + source.slice(offset + anchor.length) }
  },
})
