import assert from 'node:assert/strict'
import test from 'node:test'
import { validateInstalledDshTuple } from '../../../../../test/blueprint/capabilities/teamstage-version.mjs'

const tuple = {
  capability_channel: 'alpha',
  source_head: 'current-head',
  source_manifest_version: 'current-version',
  packages: { '@deepseek-ai/dsh': { version: 'current-version', integrity: 'current-integrity' } }
}

test('W3 C-DV-02: an older installed DSH is rejected before a provider or profile can run', () => {
  assert.throws(() => validateInstalledDshTuple(tuple, [{ name: '@deepseek-ai/dsh', version: 'older-version' }]), { code: 'HOST_DSH_VERSION_MISMATCH' })
})
test('W3 C-DV-02: same-version integrity drift cannot reuse an old latest seal', () => {
  assert.throws(() => validateInstalledDshTuple(tuple, [{ name: '@deepseek-ai/dsh', version: 'current-version', integrity: 'changed-integrity' }]), {
    code: 'HOST_DSH_INTEGRITY_MISMATCH'
  })
})
test('W3 C-DV-01: an empty installed inventory cannot prove the current runtime', () => {
  assert.throws(() => validateInstalledDshTuple(tuple, []), { code: 'HOST_DSH_TUPLE_EMPTY' })
})
test('W3 C-DV-02: exact latest runtime/package bytes pass without an old-version fallback', () => {
  validateInstalledDshTuple(tuple, [{ name: '@deepseek-ai/dsh', version: 'current-version', integrity: 'current-integrity' }])
})

test('W3 C-DV-01: the resolved official capability channel can move to latest', () => {
  validateInstalledDshTuple({ ...tuple, capability_channel: 'latest' }, [{ name: '@deepseek-ai/dsh', version: 'current-version' }])
})
test('W3 C-DV-02: registry verification requires an actual integrity value', () => {
  assert.throws(() => validateInstalledDshTuple(tuple, [{ name: '@deepseek-ai/dsh', version: 'current-version' }], { requireIntegrity: true }), {
    code: 'HOST_DSH_INTEGRITY_MISMATCH'
  })
})
